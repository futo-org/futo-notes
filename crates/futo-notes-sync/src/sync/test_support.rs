use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Clone, Default)]
pub(super) struct ResponseGate {
    state: Arc<(Mutex<GateState>, Condvar)>,
}

#[derive(Default)]
struct GateState {
    request_blocked: bool,
    released: bool,
}

impl ResponseGate {
    pub(super) fn block_response(&self) {
        let (state, changed) = &*self.state;
        let mut state = state.lock().unwrap();
        state.request_blocked = true;
        changed.notify_all();
        while !state.released {
            state = changed.wait(state).unwrap();
        }
    }

    pub(super) async fn wait_until_blocked(&self) {
        let gate = self.clone();
        tokio::task::spawn_blocking(move || {
            let (state, changed) = &*gate.state;
            let state = state.lock().unwrap();
            let (state, timeout) = changed
                .wait_timeout_while(state, Duration::from_secs(5), |state| {
                    !state.request_blocked
                })
                .unwrap();
            assert!(
                state.request_blocked && !timeout.timed_out(),
                "response was not blocked before the safety timeout"
            );
        })
        .await
        .unwrap();
    }

    pub(super) fn release(&self) {
        let (state, changed) = &*self.state;
        state.lock().unwrap().released = true;
        changed.notify_all();
    }
}
