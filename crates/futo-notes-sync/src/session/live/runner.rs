use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, Mutex};

use crate::checkpoint::ConnectedState;
use crate::server::HttpClients;

use super::super::{connect, SyncSessionListener};
use super::connected_stream::{
    run_connected_stream, run_cycle_and_notify, CycleOutcome, LiveCycle, LiveSchedule,
    StreamOutcome,
};
use super::LiveTaskContext;
use crate::journal::SyncTrigger;

const RECONNECT_BACKOFF_MIN: Duration = Duration::from_secs(1);
const RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(30);

enum ConnectionOutcome {
    Connected(reqwest::Response),
    Reconnect,
    Stop,
}

#[derive(PartialEq, Eq)]
enum ReconnectOutcome {
    Retry,
    Stop,
}

pub(super) async fn run_live_task(
    context: LiveTaskContext,
    mut cancel: mpsc::Receiver<()>,
    mut note_changed: mpsc::Receiver<()>,
) {
    let LiveTaskContext {
        state,
        cycle_gate,
        root,
        listener,
        pre_write,
        journal,
        clients,
    } = context;
    let mut schedule = LiveSchedule::start().await;
    let mut reconnect_backoff = RECONNECT_BACKOFF_MIN;
    let live_cycle = LiveCycle::new(
        &state,
        &cycle_gate,
        &root,
        listener.as_ref(),
        pre_write.as_ref(),
        &journal,
        &clients,
    );

    loop {
        let response = match connect_event_stream(
            &state,
            &clients,
            listener.as_ref(),
            &mut cancel,
            &mut schedule,
            &live_cycle,
        )
        .await
        {
            ConnectionOutcome::Connected(response) => response,
            ConnectionOutcome::Reconnect => {
                if wait_for_reconnect(
                    &mut reconnect_backoff,
                    &mut cancel,
                    &mut schedule,
                    &live_cycle,
                )
                .await
                    == ReconnectOutcome::Stop
                {
                    break;
                }
                continue;
            }
            ConnectionOutcome::Stop => break,
        };

        reconnect_backoff = RECONNECT_BACKOFF_MIN;
        listener.on_connected();
        if matches!(
            run_connected_stream(
                response,
                &live_cycle,
                &mut cancel,
                &mut note_changed,
                &mut schedule,
            )
            .await,
            StreamOutcome::Stop
        ) {
            break;
        }

        if wait_for_reconnect(
            &mut reconnect_backoff,
            &mut cancel,
            &mut schedule,
            &live_cycle,
        )
        .await
            == ReconnectOutcome::Stop
        {
            break;
        }
    }

    listener.on_stopped();
}

async fn connect_event_stream(
    state: &Arc<Mutex<Option<ConnectedState>>>,
    clients: &HttpClients,
    listener: &dyn SyncSessionListener,
    cancel: &mut mpsc::Receiver<()>,
    schedule: &mut LiveSchedule,
    live_cycle: &LiveCycle<'_>,
) -> ConnectionOutcome {
    let Some(snapshot) = state.lock().await.clone() else {
        return ConnectionOutcome::Stop;
    };
    let http = match connect::client(clients, &snapshot) {
        Ok(http) => http,
        Err(error) => {
            listener.on_error(error.message());
            return ConnectionOutcome::Reconnect;
        }
    };

    let Some(response) = await_with_safety_poll(http.events(), cancel, schedule, || {
        run_cycle_and_notify(live_cycle, SyncTrigger::SafetyPoll)
    })
    .await
    else {
        return ConnectionOutcome::Stop;
    };
    match response {
        Ok(response) => ConnectionOutcome::Connected(response),
        Err(error) if error.is(401) => {
            listener.on_error(format!("auth: {error}"));
            ConnectionOutcome::Stop
        }
        Err(error) => {
            listener.on_error(format!("connect: {error}"));
            ConnectionOutcome::Reconnect
        }
    }
}

async fn await_with_safety_poll<F, P, PF>(
    request: F,
    cancel: &mut mpsc::Receiver<()>,
    schedule: &mut LiveSchedule,
    mut on_poll: P,
) -> Option<F::Output>
where
    F: Future,
    P: FnMut() -> PF,
    PF: Future<Output = CycleOutcome>,
{
    tokio::pin!(request);
    loop {
        tokio::select! {
            _ = cancel.recv() => return None,
            response = &mut request => return Some(response),
            _ = schedule.safety_poll.tick() => {
                if on_poll().await == CycleOutcome::Stop { return None; }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test(start_paused = true)]
    async fn hung_event_handshake_still_runs_the_safety_poll() {
        let polls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&polls);
        let (cancel_tx, mut cancel_rx) = mpsc::channel(1);
        let task = tokio::spawn(async move {
            let mut schedule = LiveSchedule::start().await;
            await_with_safety_poll(
                std::future::pending::<()>(),
                &mut cancel_rx,
                &mut schedule,
                || {
                    observed.fetch_add(1, Ordering::SeqCst);
                    async { CycleOutcome::Continue }
                },
            )
            .await
        });
        tokio::task::yield_now().await;
        tokio::time::advance(super::super::connected_stream::SAFETY_POLL).await;
        tokio::task::yield_now().await;
        assert_eq!(polls.load(Ordering::SeqCst), 1);
        cancel_tx.send(()).await.unwrap();
        assert_eq!(task.await.unwrap(), None);
    }
}

async fn wait_for_reconnect(
    reconnect_backoff: &mut Duration,
    cancel: &mut mpsc::Receiver<()>,
    schedule: &mut LiveSchedule,
    live_cycle: &LiveCycle<'_>,
) -> ReconnectOutcome {
    if await_with_safety_poll(
        tokio::time::sleep(*reconnect_backoff),
        cancel,
        schedule,
        || run_cycle_and_notify(live_cycle, SyncTrigger::SafetyPoll),
    )
    .await
    .is_none()
    {
        return ReconnectOutcome::Stop;
    }
    *reconnect_backoff = (*reconnect_backoff * 2).min(RECONNECT_BACKOFF_MAX);
    ReconnectOutcome::Retry
}
