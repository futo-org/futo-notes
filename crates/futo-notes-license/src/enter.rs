//! The atomic enter-a-key workflow, and the one network call in this crate.

use time::OffsetDateTime;

use crate::config::{activation_url, LicenseConfig};
use crate::input::{recognize_input, LicenseInput, LicensePair};
use crate::key::is_valid_license_key;
use crate::state::{evaluate, InvalidReason, LicenseState};

/// What a shell must hand back to this crate to perform the one activation
/// request. Deliberately dumb: the crate builds the URL and judges the answer,
/// so no shell can invent a second endpoint, a retry, or a background refresh.
///
/// Implementations MUST NOT retry, follow a redirect to another origin, or send
/// anything beyond the URL — no identifiers, no headers about the user.
pub trait ActivationTransport {
    /// Perform one `GET`. Return the response even for a 404; reserve `Err` for
    /// "the request did not complete".
    fn get(&self, url: &str) -> Result<HttpResponse, TransportError>;
}

/// The parts of an HTTP response this crate reads. The activation is plain
/// text.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// The request did not complete: no connectivity, DNS failure, TLS failure,
/// timeout. The message is for logs, never for the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError {
    message: String,
}

impl TransportError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

/// Why entering a key did not produce a license. Each variant maps to exactly
/// one specified message (docs/spec/license.md § Entering a key).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnterKeyError {
    /// "This license key isn't valid" — and nothing is stored.
    Invalid(InvalidReason),
    /// The activation endpoint answered 404: not found, not valid, or revoked.
    /// Also "This license key isn't valid".
    NotFound,
    /// "Connect to the internet to activate this key" — and nothing is stored.
    ///
    /// The spec defines only 200 and 404, so every other status is a rule this
    /// crate adds: it reads as a transport failure, because a 500 or a stray
    /// redirect is not proof that a key is bad, and the fail-safe answer is the
    /// one that stores nothing and invites a retry by hand.
    Transport(TransportError),
}

/// A license the shell may store. `state` is `Licensed` or `Expired`, never
/// `Invalid`: an already-expired license is still stored, and still says
/// "Supporter since".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedLicense {
    /// The two strings to persist, exactly as given.
    pub pair: LicensePair,
    pub state: LicenseState,
}

/// Recognise, activate if the input was a bare key, verify, and hand back the
/// pair to store — one call, so no shell has to sequence these steps and get
/// the order wrong (AGENTS.md §4.6).
///
/// The network is touched **only** on the bare-key path, exactly once, with no
/// retry. Shapes 2 and 3 — and any input that is not a well-formed key — never
/// reach the transport at all.
pub fn enter_license_key(
    raw: &str,
    config: LicenseConfig<'_>,
    now: OffsetDateTime,
    transport: &dyn ActivationTransport,
) -> Result<AcceptedLicense, EnterKeyError> {
    let pair = match recognize_input(raw) {
        None => return Err(EnterKeyError::Invalid(InvalidReason::UnrecognizedInput)),
        Some(LicenseInput::Pair(pair)) => pair,
        Some(LicenseInput::BareKey(key)) => {
            if !is_valid_license_key(&key) {
                return Err(EnterKeyError::Invalid(InvalidReason::MalformedKey));
            }
            let activation = activate(&key, config, transport)?;
            LicensePair { key, activation }
        }
    };

    match evaluate(&pair, config, now) {
        LicenseState::Invalid(reason) => Err(EnterKeyError::Invalid(reason)),
        state => Ok(AcceptedLicense { pair, state }),
    }
}

fn activate(
    key: &str,
    config: LicenseConfig<'_>,
    transport: &dyn ActivationTransport,
) -> Result<String, EnterKeyError> {
    let response = transport
        .get(&activation_url(config, key))
        .map_err(EnterKeyError::Transport)?;
    match response.status {
        200 => Ok(response.body.trim().to_string()),
        404 => Err(EnterKeyError::NotFound),
        status => Err(EnterKeyError::Transport(TransportError::new(format!(
            "activation request answered HTTP {status}"
        )))),
    }
}
