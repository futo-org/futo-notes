//! Evaluating the stored pair, entering a key, and handling a license link.

use super::*;

/// Evaluates whatever the shell has stored. Pure: no network, no storage, no
/// side effects — safe to call on the main thread at first render (M1).
///
/// `bundle_id` is the dev/prod split (M3): a `.dev` build verifies against the
/// staging org key and can never accept a production license, and vice versa.
/// An unrecognized id is treated as production, which is the fail-closed
/// direction.
#[uniffi::export]
pub fn license_evaluate(stored: Option<LicensePair>, bundle_id: String) -> LicenseView {
    evaluate_at(stored, &bundle_id, OffsetDateTime::now_utc())
}

/// Applies one delivered URL, without storing anything: the shell persists
/// [`LicenseAcceptance::pair`] when the answer is `Accepted`.
///
/// Fully offline. A `futonotes://license/{key}/{activation}` link is one of the
/// three shapes the key field accepts, so it goes through the very same
/// workflow — the link path and the field path cannot drift apart.
#[uniffi::export]
pub fn license_handle_deep_link(url: String, bundle_id: String) -> LicenseLinkOutcome {
    handle_deep_link_with(&url, &bundle_id, OffsetDateTime::now_utc(), &OfflineOnly)
}

/// Recognize the input, activate it if the user typed a bare key, verify, and
/// hand back the pair to store — one call, so no shell sequences
/// activate-then-verify (AGENTS.md §4.6).
///
/// The network is touched only on the bare-key path, exactly once, with no
/// retry. Async because that one request must never block a UI thread; the
/// whole workflow runs on a thread of its own (see [`Pay2Transport`]).
#[uniffi::export]
pub async fn license_enter_key(
    input: String,
    bundle_id: String,
) -> Result<LicenseAcceptance, LicenseError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // A plain thread rather than the caller's executor: the crate's transport
    // is synchronous by design (it is what stops a shell from inventing a
    // retry loop), and this keeps the one blocking GET off every runtime,
    // whichever one UniFFI hands us.
    std::thread::spawn(move || {
        let outcome = enter_key_with(
            &input,
            &bundle_id,
            OffsetDateTime::now_utc(),
            &Pay2Transport,
        );
        let _ = sender.send(outcome);
    });
    receiver.await.unwrap_or_else(|_| {
        // The worker died without answering — a bug in this projection, not a
        // network failure. The user still gets the fail-safe outcome (nothing
        // was stored, entering again is free), but it must leave a trace
        // rather than masquerade silently as "offline" (M11).
        futo_notes_core::log_to_stderr!(
            "[license] the activation worker stopped before it answered"
        );
        Err(LicenseError::Offline {
            reason: "the activation worker stopped before it answered".to_string(),
        })
    })
}

// ── The seams the tests drive: same code, with the clock and transport in. ──

fn config_for(bundle_id: &str) -> LicenseConfig<'static> {
    Environment::for_bundle_id(bundle_id).config()
}

pub(super) fn evaluate_at(
    stored: Option<LicensePair>,
    bundle_id: &str,
    now: OffsetDateTime,
) -> LicenseView {
    let Some(pair) = stored else {
        return unlicensed();
    };
    view_of(&evaluate(&pair.into(), config_for(bundle_id), now))
}

pub(super) fn enter_key_with(
    input: &str,
    bundle_id: &str,
    now: OffsetDateTime,
    transport: &dyn ActivationTransport,
) -> Result<LicenseAcceptance, LicenseError> {
    match enter_license_key(input, config_for(bundle_id), now, transport) {
        Ok(accepted) => Ok(LicenseAcceptance {
            pair: accepted.pair.into(),
            view: view_of(&accepted.state),
        }),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn handle_deep_link_with(
    url: &str,
    bundle_id: &str,
    now: OffsetDateTime,
    transport: &dyn ActivationTransport,
) -> LicenseLinkOutcome {
    // Two questions, and only the first belongs to the shell layer: is this URL
    // ours at all? `None` is a host or path this app does not define, which the
    // spec requires be ignored silently.
    if parse_deep_link(url).is_none() {
        return LicenseLinkOutcome::Ignored;
    }
    match enter_key_with(url, bundle_id, now, transport) {
        Ok(acceptance) => LicenseLinkOutcome::Accepted { acceptance },
        // A link has one failure message, so both errors land here. The
        // transport arm is unreachable — a link is always a complete pair —
        // and `no_request_is_made_for_a_deep_link` proves it.
        Err(_) => LicenseLinkOutcome::Rejected,
    }
}

/// The transport for paths that must never reach the network. A deep link
/// always carries its activation, so the crate never asks this for anything;
/// answering with a transport error rather than a panic keeps a future shape
/// change from taking the app down.
struct OfflineOnly;

impl ActivationTransport for OfflineOnly {
    fn get(&self, _url: &str) -> Result<futo_notes_license::HttpResponse, TransportError> {
        Err(TransportError::new(
            "a license link never contacts the activation endpoint",
        ))
    }
}

impl From<EnterKeyError> for LicenseError {
    fn from(error: EnterKeyError) -> Self {
        match error {
            EnterKeyError::Invalid(_) | EnterKeyError::NotFound => LicenseError::Invalid,
            EnterKeyError::Transport(transport) => LicenseError::Offline {
                reason: transport.message().to_string(),
            },
        }
    }
}

pub(super) fn unlicensed() -> LicenseView {
    LicenseView {
        status: LicenseStatus::Unlicensed,
        issued_at_millis: None,
        expires_at_millis: None,
        key: None,
    }
}

/// Infallible by construction: an `OffsetDateTime` is already an instant, and
/// milliseconds since the epoch fit an `i64` for any date either platform can
/// render. Nothing here can turn a real expiry into `None`.
fn epoch_millis(value: OffsetDateTime) -> i64 {
    (value.unix_timestamp_nanos() / 1_000_000) as i64
}

fn view_of(state: &LicenseState) -> LicenseView {
    match state {
        LicenseState::Licensed(details) | LicenseState::Expired(details) => LicenseView {
            status: state.status().into(),
            issued_at_millis: details.issued_at.map(epoch_millis),
            expires_at_millis: details.expires_at.map(epoch_millis),
            key: Some(details.key.clone()),
        },
        LicenseState::Invalid(_) => unlicensed(),
    }
}
