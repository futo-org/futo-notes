//! Cancelling a wait: which waits a `cancel_wait` reaches, and how soon.

use std::time::Duration;

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::{signed_in, NOT_ENTITLED};
use crate::hosted::{EntitlementOutcome, HostedSetup, PollSchedule};

const ENTITLED: &str = r#"{"entitled":true,"state":"active","plan":{"storage_quota_bytes":1,"blob_max_bytes":1},"usage":{"bytes_used":0}}"#;

/// A signed-in setup whose billing answers `body`, `delay` after each request.
async fn billing_answering(body: &'static str, delay: Duration) -> (MockServer, HostedSetup) {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/billing"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(body, "application/json")
                .set_delay(delay),
        )
        .mount(&server)
        .await;
    let setup = HostedSetup::at(&server.uri()).unwrap();
    signed_in(&setup);
    (server, setup)
}

/// The Android tab reports its close after a sign-in already finished, so a
/// cancel with nothing waiting is routine. It must not end the next wait.
#[tokio::test]
async fn a_cancel_with_nothing_waiting_does_not_end_the_next_wait() {
    let (_server, setup) = billing_answering(ENTITLED, Duration::ZERO).await;
    assert!(matches!(
        setup.await_entitled(setup.request_wait()).await.unwrap(),
        EntitlementOutcome::Entitled(_)
    ));

    setup.cancel_wait();

    assert!(matches!(
        setup.await_entitled(setup.request_wait()).await.unwrap(),
        EntitlementOutcome::Entitled(_)
    ));
}

/// A cancel that lands while a poll is in flight ends the wait as that poll
/// answers, not an interval later: nothing is listening for it right then.
#[tokio::test]
async fn a_cancel_during_a_poll_ends_the_wait_when_the_poll_answers() {
    let (server, setup) = billing_answering(NOT_ENTITLED, Duration::from_millis(200)).await;
    let a_minute = PollSchedule {
        first: Duration::from_secs(60),
        max: Duration::from_secs(60),
        give_up_after: Duration::from_secs(600),
    };
    let setup = setup.with_schedules(a_minute, a_minute);

    let wait = setup.await_entitled(setup.request_wait());
    let cancel = async {
        while server.received_requests().await.unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        setup.cancel_wait();
    };
    let (outcome, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(wait, cancel)
    })
    .await
    .expect("the cancel waited for the next interval");

    assert_eq!(outcome.unwrap(), EntitlementOutcome::Cancelled);
}
