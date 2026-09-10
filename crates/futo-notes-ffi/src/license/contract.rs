//! The UniFFI license contract: what iOS and Android call, and what they get
//! back. Records and enums only — no copy, no storage, no platform branching.

use futo_notes_license::{
    buy_url, enter_license_key, evaluate, parse_deep_link, ActivationTransport, EnterKeyError,
    Environment, LicenseConfig, LicenseState, OffsetDateTime, Platform, TransportError,
    DEEP_LINK_SCHEME, SUPPORT_MAILTO,
};

use super::transport::Pay2Transport;

/// The two plain strings a shell stores, and the only license state that is
/// ever persisted. Nothing else about a license is written to disk.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LicensePair {
    /// Normalized (trimmed, uppercased) license key.
    pub key: String,
    /// The activation exactly as issued — base64url is case-sensitive, so a
    /// shell that "tidies" this string breaks verification.
    pub activation: String,
}

impl From<futo_notes_license::LicensePair> for LicensePair {
    fn from(pair: futo_notes_license::LicensePair) -> Self {
        Self {
            key: pair.key,
            activation: pair.activation,
        }
    }
}

impl From<LicensePair> for futo_notes_license::LicensePair {
    fn from(pair: LicensePair) -> Self {
        Self {
            key: pair.key,
            activation: pair.activation,
        }
    }
}

/// The License row's three states (docs/spec/license.md § States and copy).
///
/// There is deliberately no `Invalid`: `InvalidReason` is diagnostic only and
/// no user ever sees it, so a stored pair that stopped verifying reaches a
/// shell as `Unlicensed` — exactly like no license at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LicenseStatus {
    Unlicensed,
    Licensed,
    Expired,
}

/// What the License row renders.
///
/// Timestamps cross as **epoch milliseconds**, because that is what both native
/// date formatters take and it is the one representation that cannot fail on
/// the way across: an RFC 3339 string has to be formatted here and re-parsed
/// there, and every failure in that round trip would render as `None` — which
/// for `expires_at` means "perpetual", turning a formatting bug into a free
/// forever-license (crates/futo-notes-license/AGENTS.md). Formatting the
/// instant for a human stays the shell's job; only it knows the locale and
/// calendar (localization.md).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LicenseView {
    pub status: LicenseStatus,
    /// `issued_at` — the source of "Supporter since {year}".
    pub issued_at_millis: Option<i64>,
    /// `expires_at`, or `None` for a perpetual license. A shell must not
    /// invent a date when this is absent; the row drops the clause instead.
    pub expires_at_millis: Option<i64>,
}

/// A license the shell should persist, together with the state to render.
///
/// Both travel together so a shell never has to ask again after an action
/// (M5), and never has to decide the order of verify and store (§4.6).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LicenseAcceptance {
    pub pair: LicensePair,
    pub view: LicenseView,
}

/// Why entering a key produced no license. Two variants, because the spec
/// defines exactly two messages.
///
/// `Invalid` deliberately covers both a key the activation endpoint does not
/// know and a pair that does not verify: the user is told the key is not valid,
/// never why the server thinks so.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Error, thiserror::Error)]
pub enum LicenseError {
    /// Render `license.keyInvalid` — "This license key isn't valid".
    #[error("this license key is not valid")]
    Invalid,
    /// Render `license.offline` — "Connect to the internet to activate this
    /// key". The reason is for logs; it is never shown.
    ///
    /// The field is `reason`, not `message`: UniFFI projects an error variant's
    /// fields as properties of a Kotlin `Exception`, where `message` is already
    /// `Throwable`'s — the generated bindings then declare it twice and the
    /// Android app does not compile. Nothing but the name changed.
    #[error("the activation request did not complete: {reason}")]
    Offline { reason: String },
}

/// What a delivered `futonotes://` URL turned out to mean.
///
/// The three arms are the spec's three behaviors, so a shell cannot invent a
/// fourth: an undefined host or path is ignored **silently**, a link at the
/// defined path either replaces the stored license or shows one toast.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum LicenseLinkOutcome {
    /// Not a license link at all. No toast, no navigation, nothing stored.
    Ignored,
    /// Store `acceptance.pair`, render `acceptance.view`, toast
    /// `license.activated`.
    Accepted { acceptance: LicenseAcceptance },
    /// A license link that did not verify. Toast `license.linkInvalid` and
    /// change nothing — the previously stored license survives.
    Rejected,
}

/// Attribution only: which client sent the buyer to checkout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LicensePlatform {
    Ios,
    Android,
}

impl From<LicensePlatform> for Platform {
    fn from(platform: LicensePlatform) -> Self {
        match platform {
            LicensePlatform::Ios => Platform::Ios,
            LicensePlatform::Android => Platform::Android,
        }
    }
}

/// The Buy / Renew and "Lost your key?" destinations, read from the crate so
/// no shell hardcodes a URL and every platform agrees. Open both in the
/// **system browser**, never an in-app WebView.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LicenseLinks {
    pub buy: String,
    pub support: String,
}

/// One control on the License row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LicenseAction {
    /// Opens [`LicenseLinks::buy`] in the system browser.
    Buy,
    /// The same destination as [`LicenseAction::Buy`], said differently once a
    /// license has expired.
    Renew,
    /// Reveals the key field.
    EnterKey,
    /// Opens [`LicenseLinks::support`].
    LostKey,
    /// Returns the device to Unlicensed. No confirmation: it is reversible by
    /// re-entering the key.
    Remove,
}

/// Which controls the row offers, in the order it offers them.
///
/// This is the spec's States-and-copy table (docs/spec/license.md), owned once
/// so the two native shells cannot drift apart on it — and so the meaning of
/// `LICENSE_LINK_OUT` is pinned by a golden rather than re-derived in Swift and
/// again in Kotlin. `link_out` is the shell's build-time constant: `false`
/// hides everything that leaves the app for a storefront, and keeps the key
/// field and the deep link (the consumption-only shape).
#[uniffi::export]
pub fn license_row_actions(status: LicenseStatus, link_out: bool) -> Vec<LicenseAction> {
    match status {
        // Remove is not a link out, so it survives the flag: a licensed user
        // can always hand the device on.
        LicenseStatus::Licensed => vec![LicenseAction::Remove],
        LicenseStatus::Unlicensed if link_out => vec![
            LicenseAction::Buy,
            LicenseAction::EnterKey,
            LicenseAction::LostKey,
        ],
        LicenseStatus::Expired if link_out => vec![
            LicenseAction::Renew,
            LicenseAction::EnterKey,
            LicenseAction::LostKey,
        ],
        LicenseStatus::Unlicensed | LicenseStatus::Expired => vec![LicenseAction::EnterKey],
    }
}

/// The URL scheme this app answers.
///
/// Exported so a shell's *build-time* registration — iOS `CFBundleURLTypes`,
/// Android's intent filter — can be asserted against the crate constant
/// instead of being trusted to stay in step by hand.
#[uniffi::export]
pub fn license_deep_link_scheme() -> String {
    DEEP_LINK_SCHEME.to_string()
}

/// Where Buy / Renew and "Lost your key?" go for this build.
///
/// `bundle_id` is the dev/prod split (M3), exactly as it is for
/// [`license_evaluate`]: the Buy destination is the generated checkout on this
/// environment's pay2 host, so a `.dev` build sends a buyer to staging
/// checkout and can never open the production storefront.
#[uniffi::export]
pub fn license_links(platform: LicensePlatform, bundle_id: String) -> LicenseLinks {
    LicenseLinks {
        buy: buy_url(
            Environment::for_bundle_id(&bundle_id).config(),
            platform.into(),
        ),
        support: SUPPORT_MAILTO.to_string(),
    }
}

/// Evaluates whatever the shell has stored. Pure: no network, no storage, no
/// side effects — safe to call on the main thread at first render (M1).
///
/// `bundle_id` is the dev/prod split (M3): a `.dev` build verifies against the
/// staging org key and can never accept a production license, and vice versa.
/// An unrecognised id is treated as production, which is the fail-closed
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

/// Recognise the input, activate it if the user typed a bare key, verify, and
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
        eprintln!("[license] the activation worker stopped before it answered");
        Err(LicenseError::Offline {
            reason: "the activation worker stopped before it answered".to_string(),
        })
    })
}

// ── The seams the tests drive: same code, with the clock and transport in. ──

fn config_for(bundle_id: &str) -> LicenseConfig<'static> {
    Environment::for_bundle_id(bundle_id).config()
}

fn evaluate_at(stored: Option<LicensePair>, bundle_id: &str, now: OffsetDateTime) -> LicenseView {
    let Some(pair) = stored else {
        return unlicensed();
    };
    view_of(&evaluate(&pair.into(), config_for(bundle_id), now))
}

fn enter_key_with(
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

fn handle_deep_link_with(
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

fn unlicensed() -> LicenseView {
    LicenseView {
        status: LicenseStatus::Unlicensed,
        issued_at_millis: None,
        expires_at_millis: None,
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
        LicenseState::Licensed(details) => LicenseView {
            status: LicenseStatus::Licensed,
            issued_at_millis: Some(epoch_millis(details.issued_at)),
            expires_at_millis: details.expires_at.map(epoch_millis),
        },
        LicenseState::Expired(details) => LicenseView {
            status: LicenseStatus::Expired,
            issued_at_millis: Some(epoch_millis(details.issued_at)),
            expires_at_millis: details.expires_at.map(epoch_millis),
        },
        LicenseState::Invalid(_) => unlicensed(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use futo_notes_license::HttpResponse;

    use super::*;

    /// The staging environment IS the conformance fixture's key pair
    /// (`STAGING_PUBLIC_KEY_BASE64`, and the placeholder-keys Gap in
    /// docs/spec/license.md), so these two strings are a real, verifiable
    /// staging license: `tests/conformance/license.json`, `licenseKey[0]` and
    /// `namedActivations.valid` — futo-notes, issued 2026-01-15, expiring
    /// 2029-01-15. If the fixture pair is ever regenerated the signature stops
    /// verifying and every test below that expects Licensed goes red, which is
    /// the correct red.
    const KEY: &str = "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78";
    const ACTIVATION: &str = "v2.eyJrZXkiOiJGTi1BQjEyLUNEMzQtRUY1Ni1HSDc4LUpLMTItTU4zNC1QUTU2LVJTNzgiLCJwcm9kdWN0IjoiZnV0by1ub3RlcyIsImlzc3VlZF9hdCI6IjIwMjYtMDEtMTVUMTA6MzA6MDBaIiwiZXhwaXJlc19hdCI6IjIwMjktMDEtMTVUMTA6MzA6MDBaIn0.UW-vdWiyHl70QilqDEJH0xHKaJAuqfArW_UqEIoIqytuSl-y5bwaHh-0r1KSLqGjs9q7E77X3UshG4iBnyheH84FslCUGrs5CV0QUeUd1SLym_g2dAi4XkI7RN8QoDKVY9V4ddYd13lbvIATbgMxA_MDlKalkmvUhJ0gkxjoN2jQnf4SmUivPp38ZuwscHrorA-iy1BQhobXS3lbws9ENO4FcknQ1A5TzWvQJ1hkUagQpWnXj1NIyOYcfqHaWSe0TD5HdXKacDVQftb_puM8YbQ5uHYSxgMdQ_rol6dKYijX0u7IhN9WuKnCTL26_bwpwbEUtAmNDr9SKVU1iO9_Gg";
    /// The same fixture key pair, `expires_at: null` — the perpetual vector.
    const PERPETUAL_ACTIVATION: &str = "v2.eyJrZXkiOiJGTi1BQjEyLUNEMzQtRUY1Ni1HSDc4LUpLMTItTU4zNC1QUTU2LVJTNzgiLCJwcm9kdWN0IjoiZnV0by1ub3RlcyIsImlzc3VlZF9hdCI6IjIwMjYtMDEtMTVUMTA6MzA6MDBaIiwiZXhwaXJlc19hdCI6bnVsbH0.tMktpuATNFfLqE3PcGrcvok4Ip0hX2MYroK163xnqBFFsRhNDNt4GRPnYLAk3-IFB18PW8dPm74PgdvVoeUr9xQQvcBW4Bma_5K_MMrudCqUsYfFc-pbP47gbpjAdhj-0JZYmRrqB78TRgL7Md0CI5qVVmwhEE7jw0f2jBFy0npii_qlicH85AgQxQjyyfFDfOpHnHfe7H6dldW7XCSaGRDRvDxO36iN3OvMxKC5nAnVEirtlj5TPZWifp7dUF_3NwwyOLfRbBBs-o1yKle2BRIWaB4yyqjNC3FYAsv1ahjkIEnNINls4An71Ouo61j70byTDOeBgXvA4ggAc2h_CQ";

    /// A `.dev` bundle id — what both native dev builds run under (M3).
    const DEV_BUNDLE_ID: &str = "com.futo.notes.dev";
    const RELEASE_BUNDLE_ID: &str = "com.futo.notes";

    /// The fixture license's two instants, as the epoch milliseconds a shell
    /// receives: 2026-01-15T10:30:00Z and 2029-01-15T10:30:00Z.
    const ISSUED_AT_MILLIS: i64 = 1_768_473_000_000;
    const EXPIRES_AT_MILLIS: i64 = 1_863_167_400_000;

    fn instant(unix_seconds: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(unix_seconds).unwrap()
    }

    /// Inside the license's term (2026-09-09T12:00:00Z).
    fn during_term() -> OffsetDateTime {
        instant(1_757_419_200)
    }

    /// Well past it (2030-02-01T00:00:00Z).
    fn after_term() -> OffsetDateTime {
        instant(1_895_097_600)
    }

    fn pair(activation: &str) -> LicensePair {
        LicensePair {
            key: KEY.to_string(),
            activation: activation.to_string(),
        }
    }

    /// Records every URL it is asked for, so a test can assert not just the
    /// answer but that the network was reached exactly as often as the spec
    /// allows — which for every path except a bare key is zero times.
    struct RecordingTransport {
        requests: Mutex<Vec<String>>,
        response: Result<HttpResponse, String>,
    }

    impl RecordingTransport {
        fn answering(status: u16, body: &str) -> Self {
            Self {
                requests: Mutex::new(Vec::new()),
                response: Ok(HttpResponse {
                    status,
                    body: body.to_string(),
                }),
            }
        }

        fn failing(message: &str) -> Self {
            Self {
                requests: Mutex::new(Vec::new()),
                response: Err(message.to_string()),
            }
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl ActivationTransport for RecordingTransport {
        fn get(&self, url: &str) -> Result<HttpResponse, TransportError> {
            self.requests.lock().unwrap().push(url.to_string());
            self.response.clone().map_err(TransportError::new)
        }
    }

    #[test]
    fn nothing_stored_is_unlicensed() {
        let view = evaluate_at(None, DEV_BUNDLE_ID, during_term());

        assert_eq!(view.status, LicenseStatus::Unlicensed);
        assert_eq!(view.issued_at_millis, None);
        assert_eq!(view.expires_at_millis, None);
    }

    /// `InvalidReason` is diagnostic only: a stored pair that no longer
    /// verifies must look exactly like no license, never leak a reason.
    #[test]
    fn a_stored_pair_that_no_longer_verifies_looks_like_no_license() {
        let tampered = pair(&ACTIVATION.replace("v2.eyJrZXki", "v2.eyJrZXkx"));

        let view = evaluate_at(Some(tampered), DEV_BUNDLE_ID, during_term());

        assert_eq!(view, unlicensed());
    }

    /// "Supporter since {year}" and "Valid until {date}" both come from the
    /// payload, so both timestamps have to cross the boundary in a form a
    /// shell can parse.
    #[test]
    fn a_licensed_pair_carries_both_timestamps() {
        let view = evaluate_at(Some(pair(ACTIVATION)), DEV_BUNDLE_ID, during_term());

        assert_eq!(view.status, LicenseStatus::Licensed);
        assert_eq!(view.issued_at_millis, Some(ISSUED_AT_MILLIS));
        assert_eq!(view.expires_at_millis, Some(EXPIRES_AT_MILLIS));
    }

    /// A perpetual product has no expiry and the row must not invent one.
    #[test]
    fn a_perpetual_license_reports_no_expiry() {
        let view = evaluate_at(
            Some(pair(PERPETUAL_ACTIVATION)),
            DEV_BUNDLE_ID,
            after_term(),
        );

        assert_eq!(view.status, LicenseStatus::Licensed);
        assert_eq!(view.expires_at_millis, None);
    }

    /// An expired license is kept on the device and still says "Supporter
    /// since", so it keeps both dates too.
    #[test]
    fn an_expired_license_keeps_its_dates() {
        let view = evaluate_at(Some(pair(ACTIVATION)), DEV_BUNDLE_ID, after_term());

        assert_eq!(view.status, LicenseStatus::Expired);
        assert_eq!(view.issued_at_millis, Some(ISSUED_AT_MILLIS));
        assert_eq!(view.expires_at_millis, Some(EXPIRES_AT_MILLIS));
    }

    /// CRITICAL (M3). The same staging license must verify on a `.dev` build
    /// and fail closed on a release build — and the selector is the bundle id
    /// the shell passes, never a compile profile: both native dev apps are
    /// built with the optimized `release-ffi` profile.
    #[test]
    fn the_bundle_id_is_the_dev_prod_split() {
        let on_dev = evaluate_at(Some(pair(ACTIVATION)), DEV_BUNDLE_ID, during_term());
        let on_release = evaluate_at(Some(pair(ACTIVATION)), RELEASE_BUNDLE_ID, during_term());

        assert_eq!(on_dev.status, LicenseStatus::Licensed);
        assert_eq!(on_release, unlicensed());
    }

    #[test]
    fn a_link_at_an_undefined_path_is_ignored_silently() {
        let transport = RecordingTransport::failing("no network in this test");

        let outcome = handle_deep_link_with(
            "futonotes://settings/open",
            DEV_BUNDLE_ID,
            during_term(),
            &transport,
        );

        assert_eq!(outcome, LicenseLinkOutcome::Ignored);
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn another_apps_scheme_is_ignored_silently() {
        let outcome = handle_deep_link_with(
            "grayjay://license/FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78/v2.a.b",
            DEV_BUNDLE_ID,
            during_term(),
            &RecordingTransport::failing("no network in this test"),
        );

        assert_eq!(outcome, LicenseLinkOutcome::Ignored);
    }

    /// A link at the DEFINED path that does not verify is the one case that
    /// earns a toast. Ignored would swallow it; Accepted would store garbage.
    #[test]
    fn a_license_link_that_does_not_verify_is_rejected() {
        let outcome = handle_deep_link_with(
            &format!("futonotes://license/{KEY}/v2.bm90LWEtbGljZW5zZQ.bm90LWEtc2ln"),
            DEV_BUNDLE_ID,
            during_term(),
            &RecordingTransport::failing("no network in this test"),
        );

        assert_eq!(outcome, LicenseLinkOutcome::Rejected);
    }

    /// The pair a shell stores must be what arrived, byte for byte: base64url
    /// is case-sensitive, and an activation "helpfully" normalized on the way
    /// through stops verifying on the next launch.
    #[test]
    fn a_valid_link_is_accepted_with_the_pair_to_store() {
        let outcome = handle_deep_link_with(
            &format!("futonotes://license/{KEY}/{ACTIVATION}"),
            DEV_BUNDLE_ID,
            during_term(),
            &RecordingTransport::failing("no network in this test"),
        );

        let LicenseLinkOutcome::Accepted { acceptance } = outcome else {
            panic!("expected the link to be accepted, got {outcome:?}");
        };
        assert_eq!(acceptance.pair.key, KEY);
        assert_eq!(acceptance.pair.activation, ACTIVATION);
        assert_eq!(acceptance.view.status, LicenseStatus::Licensed);
    }

    /// Zero background network is the rule that makes this module safe to call
    /// from a URL handler at launch. A link carries its activation, so it
    /// verifies offline — this is the test that goes red if the link path ever
    /// starts activating.
    #[test]
    fn no_request_is_made_for_a_deep_link() {
        let transport = RecordingTransport::answering(200, ACTIVATION);

        handle_deep_link_with(
            &format!("futonotes://license/{KEY}/{ACTIVATION}"),
            DEV_BUNDLE_ID,
            during_term(),
            &transport,
        );

        assert_eq!(transport.requests(), Vec::<String>::new());
    }

    #[test]
    fn a_pasted_pair_never_reaches_the_network() {
        let transport = RecordingTransport::answering(200, ACTIVATION);

        let accepted = enter_key_with(
            &format!("{KEY}/{ACTIVATION}"),
            DEV_BUNDLE_ID,
            during_term(),
            &transport,
        )
        .unwrap();

        assert_eq!(accepted.view.status, LicenseStatus::Licensed);
        assert_eq!(transport.requests(), Vec::<String>::new());
    }

    /// The bare-key path is the only network in the whole license module:
    /// exactly one GET, at the staging host because the bundle id says `.dev`,
    /// and then the returned pair is verified before it is handed back.
    #[test]
    fn a_bare_key_makes_exactly_one_staging_request() {
        let transport = RecordingTransport::answering(200, ACTIVATION);

        let accepted = enter_key_with(KEY, DEV_BUNDLE_ID, during_term(), &transport).unwrap();

        assert_eq!(
            transport.requests(),
            vec![format!(
                "https://staging-pay2.futo.org/api/v1/activate/{KEY}"
            )]
        );
        assert_eq!(accepted.pair.activation, ACTIVATION);
        assert_eq!(accepted.view.status, LicenseStatus::Licensed);
    }

    /// The spec gives a 404 and a failed verification the SAME message, and
    /// reserves "connect to the internet" for a request that did not complete.
    /// Getting this backwards tells a user with a typo'd key to check their
    /// network.
    #[test]
    fn a_rejected_key_and_a_missing_key_share_one_error() {
        let missing = enter_key_with(
            KEY,
            DEV_BUNDLE_ID,
            during_term(),
            &RecordingTransport::answering(404, "not found"),
        );
        let rubbish = enter_key_with(
            "not a license",
            DEV_BUNDLE_ID,
            during_term(),
            &RecordingTransport::failing("no network in this test"),
        );

        assert_eq!(missing, Err(LicenseError::Invalid));
        assert_eq!(rubbish, Err(LicenseError::Invalid));
    }

    #[test]
    fn a_request_that_did_not_complete_asks_the_user_to_connect() {
        let entered = enter_key_with(
            KEY,
            DEV_BUNDLE_ID,
            during_term(),
            &RecordingTransport::failing("dns failure"),
        );

        assert!(
            matches!(entered, Err(LicenseError::Offline { .. })),
            "expected Offline, got {entered:?}"
        );
    }

    /// The spec's States-and-copy table, in the order the row renders.
    #[test]
    fn the_row_actions_are_the_specified_table() {
        assert_eq!(
            license_row_actions(LicenseStatus::Unlicensed, true),
            vec![
                LicenseAction::Buy,
                LicenseAction::EnterKey,
                LicenseAction::LostKey
            ]
        );
        assert_eq!(
            license_row_actions(LicenseStatus::Licensed, true),
            vec![LicenseAction::Remove]
        );
        assert_eq!(
            license_row_actions(LicenseStatus::Expired, true),
            vec![
                LicenseAction::Renew,
                LicenseAction::EnterKey,
                LicenseAction::LostKey
            ]
        );
    }

    /// `LICENSE_LINK_OUT = false` is the consumption-only shape a store
    /// objection would force: it hides Buy, Renew and Lost-your-key, and keeps
    /// the key field (and the deep link, which is not a control at all).
    #[test]
    fn link_out_false_hides_every_way_out_of_the_app_and_nothing_else() {
        assert_eq!(
            license_row_actions(LicenseStatus::Unlicensed, false),
            vec![LicenseAction::EnterKey]
        );
        assert_eq!(
            license_row_actions(LicenseStatus::Expired, false),
            vec![LicenseAction::EnterKey]
        );
        // Remove is not a way out of the app, so it must survive the flag.
        assert_eq!(
            license_row_actions(LicenseStatus::Licensed, false),
            vec![LicenseAction::Remove]
        );
    }

    #[test]
    fn the_buy_url_carries_the_platform() {
        assert_eq!(
            license_links(LicensePlatform::Ios, "com.futo.notes".into()).buy,
            "https://pay2.futo.org/checkout/polar/futo-notes/futo-notes\
             /checkout-ready?platform=ios&success="
        );
        assert_eq!(
            license_links(LicensePlatform::Android, "com.futo.notes".into()).buy,
            "https://pay2.futo.org/checkout/polar/futo-notes/futo-notes\
             /checkout-ready?platform=android&success="
        );
        assert_eq!(
            license_links(LicensePlatform::Ios, "com.futo.notes".into()).support,
            "mailto:support@futo.tech"
        );
    }

    /// The defect this split fixed: a `.dev` build's Buy button opened the
    /// production storefront, so staging checkout was unreachable from the app
    /// that verifies against the staging key (M3).
    #[test]
    fn a_dev_build_buys_on_staging() {
        assert_eq!(
            license_links(LicensePlatform::Android, "com.futo.notes.dev".into()).buy,
            "https://staging-pay2.futo.org/checkout/polar/futo-notes/futo-notes\
             /checkout-ready?platform=android&success="
        );
    }

    /// The shells register this scheme at BUILD time (`CFBundleURLTypes`, an
    /// intent filter), so they need the crate's answer to assert against.
    #[test]
    fn the_registered_scheme_is_the_crates_scheme() {
        assert_eq!(license_deep_link_scheme(), "futonotes");
    }
}
