use std::sync::{Arc, Mutex};

use super::*;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A platform trust store that failed to build still leaves http:// working and
/// refuses https://. reqwest 0.13 is built here without a crypto provider of its
/// own, so this path must hand reqwest its own (empty-roots) config: building a
/// client without one panics.
#[tokio::test]
async fn a_failed_trust_store_still_serves_http_and_refuses_https() {
    let clients = HttpClients {
        trust: Err(HttpError {
            status: None,
            message: "could not build the TLS trust store: test".into(),
        }),
        connections: Arc::new(Mutex::new(
            Connections::open(None, 0).expect("untrusted clients build"),
        )),
    };
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ping"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let http = clients.for_base(&server.uri()).unwrap();
    let response = http.request(Method::GET, "/ping").send().await.unwrap();
    assert!(response.status().is_success());
    assert!(clients.for_base("https://example.invalid").is_err());
}
