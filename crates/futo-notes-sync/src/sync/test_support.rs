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

pub(super) struct ResponseReleaseGuard(ResponseGate);

impl Drop for ResponseReleaseGuard {
    fn drop(&mut self) {
        self.0.release();
    }
}

impl ResponseGate {
    // A failed assertion must unblock wiremock before its server is dropped.
    pub(super) fn release_on_drop(&self) -> ResponseReleaseGuard {
        ResponseReleaseGuard(self.clone())
    }

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

#[tokio::test]
async fn a_blocked_response_server_does_not_block_an_independent_server() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let primary = MockServer::start().await;
    let sidecar = MockServer::start().await;
    let gate = ResponseGate::default();
    // Drop this before either server, including after a failed assertion.
    let _release = gate.release_on_drop();
    let response_gate = gate.clone();
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(move |_: &wiremock::Request| {
            response_gate.block_response();
            ResponseTemplate::new(200).set_body_string("released")
        })
        .mount(&sidecar)
        .await;
    Mock::given(method("GET"))
        .and(path("/fast"))
        .respond_with(ResponseTemplate::new(200).set_body_string("live"))
        .mount(&primary)
        .await;

    let slow = tokio::spawn(reqwest::get(format!("{}/slow", sidecar.uri())));
    gate.wait_until_blocked().await;
    let fast = tokio::time::timeout(
        Duration::from_secs(5),
        reqwest::get(format!("{}/fast", primary.uri())),
    )
    .await
    .expect("a blocked sidecar must not freeze an independent server")
    .unwrap();
    assert_eq!(fast.text().await.unwrap(), "live");
    gate.release();
    assert_eq!(
        slow.await.unwrap().unwrap().text().await.unwrap(),
        "released"
    );
}

#[tokio::test]
async fn response_gate_releases_when_a_test_assertion_unwinds() {
    let gate = ResponseGate::default();
    let response_gate = gate.clone();
    let blocked = std::thread::spawn(move || response_gate.block_response());
    gate.wait_until_blocked().await;
    let panic = std::panic::catch_unwind(|| {
        let _release = gate.release_on_drop();
        panic!("seeded assertion failure while a response is blocked");
    });
    assert!(panic.is_err());
    blocked.join().unwrap();
}
