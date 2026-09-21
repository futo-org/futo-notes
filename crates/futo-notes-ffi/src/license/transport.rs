//! The one activation request the native shells ever make.
//!
//! It lives here rather than in Swift and Kotlin on purpose: the crate's
//! contract is "exactly one GET, no retry, no redirect chase, nothing sent
//! beyond the URL", and a policy written twice in two languages is a policy
//! that drifts. Both shells get it by calling
//! [`crate::license_enter_key`](super::contract::license_enter_key).

use std::time::Duration;

use futo_notes_license::{ActivationTransport, HttpResponse, TransportError};

/// One request, no retry. The crate forbids a second attempt; these bounds
/// only stop the one attempt from hanging a user's tap forever. They match the
/// desktop projection (`apps/tauri/src-tauri/src/license.rs`).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

pub(super) struct Pay2Transport;

impl ActivationTransport for Pay2Transport {
    fn get(&self, url: &str) -> Result<HttpResponse, TransportError> {
        // `license_enter_key` already put us on a thread of our own, so a
        // current-thread runtime here is the whole reactor this one request
        // needs — no executor is blocked, and nothing is nested inside another
        // runtime.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| TransportError::new(error.to_string()))?;
        runtime.block_on(async {
            let client = reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                // A 3xx becomes a non-200 status, which the crate reads as
                // "not proof the key is bad" rather than as a rejection.
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| TransportError::new(error.to_string()))?;
            let response = client
                .get(url)
                .send()
                .await
                .map_err(|error| TransportError::new(error.to_string()))?;
            let status = response.status().as_u16();
            let body = response
                .text()
                .await
                .map_err(|error| TransportError::new(error.to_string()))?;
            Ok(HttpResponse { status, body })
        })
    }
}
