use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, Mutex};
use tokio::time::{interval, Instant, MissedTickBehavior};

use crate::checkpoint::ConnectedState;
use crate::sync::{PreWrite, SyncErrorKind};

use super::super::{cycle, SyncSessionListener};
use super::event_stream::EventStream;

const SAFETY_POLL: Duration = Duration::from_secs(45);
const READ_IDLE: Duration = Duration::from_secs(90);
const REMOTE_CHANGE_DEBOUNCE: Duration = Duration::from_millis(300);
const LOCAL_CHANGE_DEBOUNCE: Duration = Duration::from_secs(1);

pub(super) struct LiveSchedule {
    safety_poll: tokio::time::Interval,
    local_push_at: Option<Instant>,
}

impl LiveSchedule {
    pub(super) async fn start() -> Self {
        let mut safety_poll = interval(SAFETY_POLL);
        safety_poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
        safety_poll.tick().await;
        Self {
            safety_poll,
            local_push_at: None,
        }
    }
}

pub(super) struct LiveCycle<'a> {
    state: &'a Arc<Mutex<Option<ConnectedState>>>,
    cycle_gate: &'a Arc<Mutex<()>>,
    root: &'a Path,
    listener: &'a dyn SyncSessionListener,
    pre_write: &'a PreWrite,
}

impl<'a> LiveCycle<'a> {
    pub(super) fn new(
        state: &'a Arc<Mutex<Option<ConnectedState>>>,
        cycle_gate: &'a Arc<Mutex<()>>,
        root: &'a Path,
        listener: &'a dyn SyncSessionListener,
        pre_write: &'a PreWrite,
    ) -> Self {
        Self {
            state,
            cycle_gate,
            root,
            listener,
            pre_write,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum CycleOutcome {
    Continue,
    Stop,
}

pub(super) enum StreamOutcome {
    Reconnect,
    Stop,
}

pub(super) async fn run_connected_stream(
    mut response: reqwest::Response,
    live_cycle: LiveCycle<'_>,
    cancel: &mut mpsc::Receiver<()>,
    note_changed: &mut mpsc::Receiver<()>,
    schedule: &mut LiveSchedule,
) -> StreamOutcome {
    if run_cycle_and_notify(&live_cycle).await == CycleOutcome::Stop {
        return StreamOutcome::Stop;
    }

    let mut event_stream = EventStream::default();
    let mut remote_pull_at = None;

    loop {
        let remote_pull_timer = wait_until_scheduled(remote_pull_at);
        let local_push_timer = wait_until_scheduled(schedule.local_push_at);

        tokio::select! {
            _ = cancel.recv() => return StreamOutcome::Stop,
            Some(()) = note_changed.recv() => {
                schedule.local_push_at = Some(Instant::now() + LOCAL_CHANGE_DEBOUNCE);
            }
            _ = local_push_timer => {
                schedule.local_push_at = None;
                if run_cycle_and_notify(&live_cycle).await == CycleOutcome::Stop {
                    return StreamOutcome::Stop;
                }
            }
            _ = remote_pull_timer => {
                remote_pull_at = None;
                if run_cycle_and_notify(&live_cycle).await == CycleOutcome::Stop {
                    return StreamOutcome::Stop;
                }
            }
            _ = schedule.safety_poll.tick() => {
                if run_cycle_and_notify(&live_cycle).await == CycleOutcome::Stop {
                    return StreamOutcome::Stop;
                }
            }
            events = read_stream_events(&mut response, &mut event_stream) => {
                match events {
                    Ok(events) => schedule_remote_pull(&events, &mut remote_pull_at),
                    Err(message) => {
                        live_cycle.listener.on_error(message);
                        return StreamOutcome::Reconnect;
                    }
                }
            }
        }
    }
}

async fn run_cycle_and_notify(live_cycle: &LiveCycle<'_>) -> CycleOutcome {
    let no_progress = |_: crate::sync::SyncProgress| {};
    match cycle::run(
        live_cycle.state,
        live_cycle.cycle_gate,
        live_cycle.root,
        &no_progress,
        live_cycle.pre_write,
    )
    .await
    {
        Ok(summary) => {
            live_cycle.listener.on_synced(summary);
            CycleOutcome::Continue
        }
        Err(error) => {
            let (outcome, message) = classify_cycle_error(&error);
            live_cycle.listener.on_cycle_error(message);
            outcome
        }
    }
}

fn classify_cycle_error(error: &SyncErrorKind) -> (CycleOutcome, String) {
    match error {
        SyncErrorKind::Auth(_) => (CycleOutcome::Stop, format!("auth: {}", error.message())),
        SyncErrorKind::CollectionGone(_) => (CycleOutcome::Stop, error.message()),
        _ => (CycleOutcome::Continue, error.message()),
    }
}

async fn read_stream_events(
    response: &mut reqwest::Response,
    event_stream: &mut EventStream,
) -> Result<Vec<String>, String> {
    match tokio::time::timeout(READ_IDLE, response.chunk()).await {
        Ok(Ok(Some(bytes))) => Ok(event_stream.push(&bytes)),
        Ok(Ok(None)) => Err("read: event stream closed".into()),
        Ok(Err(error)) => Err(format!("read: {error}")),
        Err(_) => Err("read: event stream idle timeout".into()),
    }
}

fn schedule_remote_pull(events: &[String], remote_pull_at: &mut Option<Instant>) {
    if events
        .iter()
        .any(|event| event == "ready" || event == "change")
    {
        *remote_pull_at = Some(Instant::now() + REMOTE_CHANGE_DEBOUNCE);
    }
}

async fn wait_until_scheduled(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_cycle_errors_stop_and_emit_reauthentication_signal() {
        let (outcome, message) = classify_cycle_error(&SyncErrorKind::Auth(
            "HTTP 401: session expired or invalid".into(),
        ));

        assert_eq!(outcome, CycleOutcome::Stop);
        assert_eq!(message, "auth: HTTP 401: session expired or invalid");
    }

    #[test]
    fn collection_gone_stops_but_transient_http_errors_continue() {
        let (gone_outcome, gone_message) = classify_cycle_error(&SyncErrorKind::CollectionGone(
            "HTTP 404: collection not found".into(),
        ));
        assert_eq!(gone_outcome, CycleOutcome::Stop);
        assert_eq!(
            gone_message,
            "collection-gone: HTTP 404: collection not found"
        );

        let (http_outcome, http_message) =
            classify_cycle_error(&SyncErrorKind::Http("HTTP 500: unavailable".into()));
        assert_eq!(http_outcome, CycleOutcome::Continue);
        assert_eq!(http_message, "HTTP 500: unavailable");
    }
}
