//! The injected activation transport the enter-key vectors run against.
use super::*;

// --- the injected transport -------------------------------------------------

pub(super) enum Outcome {
    /// Any request at all is a test failure: these vectors prove the crate is
    /// offline outside the one explicit bare-key path.
    Unavailable,
    Response {
        status: u16,
        body: String,
    },
    Failure {
        message: String,
    },
}

pub(super) struct FakeTransport {
    pub(super) outcome: Outcome,
    pub(super) requests: RefCell<Vec<String>>,
}

impl ActivationTransport for FakeTransport {
    fn get(&self, url: &str) -> Result<HttpResponse, TransportError> {
        self.requests.borrow_mut().push(url.to_string());
        match &self.outcome {
            Outcome::Unavailable => {
                panic!("the license crate made a network request it must never make: GET {url}")
            }
            Outcome::Response { status, body } => Ok(HttpResponse {
                status: *status,
                body: body.clone(),
            }),
            Outcome::Failure { message } => Err(TransportError::new(message)),
        }
    }
}

pub(super) fn transport_for(fixture: &Value, spec: &Value) -> FakeTransport {
    let outcome = match text(spec, "kind") {
        "unavailable" => Outcome::Unavailable,
        "response" => Outcome::Response {
            status: spec["status"].as_u64().expect("status") as u16,
            body: resolve(fixture, text(spec, "body")),
        },
        "failure" => Outcome::Failure {
            message: text(spec, "message").to_string(),
        },
        other => panic!("unknown transport kind {other:?}"),
    };
    FakeTransport {
        outcome,
        requests: RefCell::new(Vec::new()),
    }
}
