use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, Mutex};

use crate::checkpoint::ConnectedState;
use crate::sync::PreWrite;

use super::super::{connect, SyncSessionListener};
use super::connected_stream::{run_connected_stream, LiveCycle, LiveSchedule, StreamOutcome};

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
    state: Arc<Mutex<Option<ConnectedState>>>,
    cycle_gate: Arc<Mutex<()>>,
    root: PathBuf,
    listener: Arc<dyn SyncSessionListener>,
    pre_write: Arc<PreWrite>,
    mut cancel: mpsc::Receiver<()>,
    mut note_changed: mpsc::Receiver<()>,
) {
    let mut schedule = LiveSchedule::start().await;
    let mut reconnect_backoff = RECONNECT_BACKOFF_MIN;

    loop {
        let response = match connect_event_stream(&state, listener.as_ref(), &mut cancel).await {
            ConnectionOutcome::Connected(response) => response,
            ConnectionOutcome::Reconnect => {
                if wait_for_reconnect(&mut reconnect_backoff, &mut cancel).await
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
        let live_cycle = LiveCycle::new(
            &state,
            &cycle_gate,
            &root,
            listener.as_ref(),
            pre_write.as_ref(),
        );
        if matches!(
            run_connected_stream(
                response,
                live_cycle,
                &mut cancel,
                &mut note_changed,
                &mut schedule,
            )
            .await,
            StreamOutcome::Stop
        ) {
            break;
        }

        if wait_for_reconnect(&mut reconnect_backoff, &mut cancel).await == ReconnectOutcome::Stop {
            break;
        }
    }

    listener.on_stopped();
}

async fn connect_event_stream(
    state: &Arc<Mutex<Option<ConnectedState>>>,
    listener: &dyn SyncSessionListener,
    cancel: &mut mpsc::Receiver<()>,
) -> ConnectionOutcome {
    let Some(snapshot) = state.lock().await.clone() else {
        return ConnectionOutcome::Stop;
    };
    let http = match connect::client(&snapshot) {
        Ok(http) => http,
        Err(error) => {
            listener.on_error(error.message());
            return ConnectionOutcome::Reconnect;
        }
    };

    let response = tokio::select! {
        _ = cancel.recv() => return ConnectionOutcome::Stop,
        response = http.events() => response,
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

async fn wait_for_reconnect(
    reconnect_backoff: &mut Duration,
    cancel: &mut mpsc::Receiver<()>,
) -> ReconnectOutcome {
    tokio::select! {
        _ = cancel.recv() => ReconnectOutcome::Stop,
        _ = tokio::time::sleep(*reconnect_backoff) => {
            *reconnect_backoff = (*reconnect_backoff * 2).min(RECONNECT_BACKOFF_MAX);
            ReconnectOutcome::Retry
        },
    }
}
