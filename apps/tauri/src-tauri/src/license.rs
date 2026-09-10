//! The desktop projection of the paid client license.
//!
//! Every license *rule* lives in `futo-notes-license` (docs/spec/license.md);
//! this module owns only what the crate deliberately pushed out to a shell:
//! where the two strings are stored, the clock, the one HTTP request, and the
//! `futonotes://` URL scheme. No rule is re-decided here — in particular the
//! shell never sequences activate-then-verify, because `enter_license_key` is
//! one atomic call (AGENTS.md §4.6).
//!
//! Copy is not here either. Commands return a typed *outcome*; the strings live
//! in `languages/en.json` under `license.` and are resolved by the frontend.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use futo_notes_license::{
    buy_url, enter_license_key, evaluate, parse_deep_link, ActivationTransport, EnterKeyError,
    Environment, HttpResponse, LicensePair, LicenseState, OffsetDateTime, Platform, TransportError,
    SUPPORT_MAILTO,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::application_state::AppState;
use crate::background_tasks::blocking;

/// The stored pair, next to the other per-build desktop state in the app data
/// dir. Never in the vault (it would sync and show up in the note list) and
/// never in the OS keyring (it is not a secret — it is a receipt).
const LICENSE_FILE: &str = "license.json";

/// One request, no retry. The crate forbids a second attempt; these bounds just
/// stop the one attempt from hanging the user's click forever.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// What the License row renders. Dates cross as RFC 3339 and are formatted by
/// the frontend, because only it knows the user's locale (localization.md).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseView {
    /// `unlicensed` | `licensed` | `expired`.
    pub state: &'static str,
    /// `issued_at` — the source of "Supporter since {year}".
    pub issued_at: Option<String>,
    /// `expires_at`, or `null` for a perpetual license.
    pub expires_at: Option<String>,
}

/// The Buy / Renew and "Lost your key?" destinations, so no shell hardcodes a
/// URL and every platform agrees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseLinks {
    pub buy: String,
    pub support: String,
}

/// The result of an action that may change the stored license.
///
/// `outcome` selects the toast; `view` is the new state to render. Both are
/// returned together so the frontend never has to ask again (M5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseActionResult {
    /// [`OUTCOME_ACTIVATED`], [`OUTCOME_INVALID`] or [`OUTCOME_OFFLINE`].
    pub outcome: &'static str,
    pub view: LicenseView,
}

pub const OUTCOME_ACTIVATED: &str = "activated";
pub const OUTCOME_INVALID: &str = "invalid";
pub const OUTCOME_OFFLINE: &str = "offline";

const STATE_UNLICENSED: &str = "unlicensed";
const STATE_LICENSED: &str = "licensed";
const STATE_EXPIRED: &str = "expired";

/// Emitted when a `futonotes://` link has been handled and its outcome is
/// waiting in the inbox.
///
/// It deliberately carries **no payload**: the inbox is the single source of a
/// link's outcome, so the shell has to drain it and cannot double-report a link
/// by reading the event instead. An outcome that stayed parked after a live
/// event would be re-toasted on the next launch (observed 2026-09-09: an
/// already-shown "isn't valid" was still sitting in the slot).
pub(crate) const LICENSE_LINK_EVENT: &str = "license:link";

/// Where a deep link's outcome waits until the shell is ready to toast it.
///
/// A link can arrive before the webview exists at all (cold start), and the
/// event emitted then reaches nobody. The link is still *applied* immediately —
/// storage is Rust's, and applying it blocks no render (M1) — and its outcome is
/// parked here for the frontend to drain once it has painted. Draining is a
/// `take`, so the outcome is delivered exactly once whether the frontend got the
/// event or the drain.
#[derive(Default)]
pub(crate) struct LicenseLinkInbox {
    pending: Mutex<Option<LicenseActionResult>>,
}

impl LicenseLinkInbox {
    fn park(&self, result: LicenseActionResult) {
        if let Ok(mut slot) = self.pending.lock() {
            *slot = Some(result);
        }
    }

    fn take(&self) -> Option<LicenseActionResult> {
        self.pending.lock().ok().and_then(|mut slot| slot.take())
    }
}

/// The one activation request, performed exactly as the crate asks: one `GET`,
/// no retry, and no redirect chase — a 3xx becomes a non-200 status, which the
/// crate reads as "not proof the key is bad" rather than as a rejection.
struct HttpActivationTransport;

impl ActivationTransport for HttpActivationTransport {
    fn get(&self, url: &str) -> Result<HttpResponse, TransportError> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| TransportError::new(error.to_string()))?;
        let response = client
            .get(url)
            .send()
            .map_err(|error| TransportError::new(error.to_string()))?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .map_err(|error| TransportError::new(error.to_string()))?;
        Ok(HttpResponse { status, body })
    }
}

/// The two plain strings on disk. Both must be present for a stored license to
/// mean anything, so a half-written file reads as "no license" rather than as a
/// pair that can never verify.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLicense {
    key: String,
    activation: String,
}

fn read_pair(path: &Path) -> Option<LicensePair> {
    let raw = std::fs::read_to_string(path).ok()?;
    let stored = serde_json::from_str::<StoredLicense>(&raw).ok()?;
    if stored.key.trim().is_empty() || stored.activation.trim().is_empty() {
        return None;
    }
    Some(LicensePair {
        key: stored.key,
        activation: stored.activation,
    })
}

fn write_pair(path: &Path, pair: &LicensePair) -> Result<(), String> {
    let stored = StoredLicense {
        key: pair.key.clone(),
        activation: pair.activation.clone(),
    };
    let json = serde_json::to_string_pretty(&stored).map_err(|error| error.to_string())?;
    futo_notes_core::files::write_atomic_text(path, &json)
}

fn clear_pair(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        // Removing a license that was never stored is the state the user asked
        // for, not a failure.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// The license file for this build. Derived from the app data dir, so the
/// dev/prod split (M3) comes from the bundle identifier for free, and
/// `FUTO_NOTES_DATA_DIR` still wins so a worktree dev run keeps its own.
fn license_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = crate::vault_location::environment_data_dir().map_or_else(
        || app.path().app_data_dir().map_err(|error| error.to_string()),
        Ok,
    )?;
    Ok(base.join(LICENSE_FILE))
}

fn rfc3339(value: OffsetDateTime) -> Option<String> {
    value
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

/// Projects the crate's verdict into what the row renders.
///
/// `Invalid` is deliberately flattened to Unlicensed: `InvalidReason` is
/// diagnostic only and no user ever sees it, so a stored pair that stopped
/// verifying looks exactly like no license at all.
fn view_of(state: &LicenseState) -> LicenseView {
    match state {
        LicenseState::Licensed(details) => LicenseView {
            state: STATE_LICENSED,
            issued_at: rfc3339(details.issued_at),
            expires_at: details.expires_at.and_then(rfc3339),
        },
        LicenseState::Expired(details) => LicenseView {
            state: STATE_EXPIRED,
            issued_at: rfc3339(details.issued_at),
            expires_at: details.expires_at.and_then(rfc3339),
        },
        LicenseState::Invalid(_) => unlicensed_view(),
    }
}

fn unlicensed_view() -> LicenseView {
    LicenseView {
        state: STATE_UNLICENSED,
        issued_at: None,
        expires_at: None,
    }
}

/// Which toast an unsuccessful entry earns. `NotFound` and `Invalid` are the
/// same message on purpose (docs/spec/license.md § Entering a key): the user is
/// told the key is not valid, never why the server thinks so.
fn outcome_of_error(error: &EnterKeyError) -> &'static str {
    match error {
        EnterKeyError::Invalid(_) | EnterKeyError::NotFound => OUTCOME_INVALID,
        EnterKeyError::Transport(_) => OUTCOME_OFFLINE,
    }
}

/// Evaluates whatever is stored, with no network and no side effects.
fn current_view(app: &AppHandle) -> Result<LicenseView, String> {
    let path = license_path(app)?;
    let Some(pair) = read_pair(&path) else {
        return Ok(unlicensed_view());
    };
    let config = Environment::for_bundle_id(&app.config().identifier).config();
    Ok(view_of(&evaluate(&pair, config, OffsetDateTime::now_utc())))
}

/// Verify (activating first if the user typed a bare key), then store. One
/// call, so the ordering invariant cannot be got wrong at a call site.
fn accept_input(app: &AppHandle, raw: &str) -> Result<LicenseActionResult, String> {
    let config = Environment::for_bundle_id(&app.config().identifier).config();
    let now = OffsetDateTime::now_utc();
    match enter_license_key(raw, config, now, &HttpActivationTransport) {
        Ok(accepted) => {
            write_pair(&license_path(app)?, &accepted.pair)?;
            Ok(LicenseActionResult {
                outcome: OUTCOME_ACTIVATED,
                view: view_of(&accepted.state),
            })
        }
        // Nothing is stored on any failure, so the previously stored license —
        // if any — survives a bad paste untouched.
        Err(error) => Ok(LicenseActionResult {
            outcome: outcome_of_error(&error),
            view: current_view(app)?,
        }),
    }
}

/// Applies one delivered URL.
///
/// Two questions, and only the first is this module's: **is this URL ours at
/// all?** `parse_deep_link` answers it, and `None` means a host or path this app
/// does not define, which the spec requires be ignored **silently** — no toast,
/// no navigation.
///
/// Everything after that is the same question the key field asks, so it is the
/// same call: a `futonotes://` URL is one of the three shapes `enter_license_key`
/// accepts, and it owns verify-then-store as one step (AGENTS.md §4.6). Deciding
/// the ordering again here is how the link path and the field path drift apart —
/// and a valid link replacing an existing license, an invalid one changing
/// nothing, are both already that workflow's behavior.
fn apply_deep_link(app: &AppHandle, url: &str) -> Option<LicenseActionResult> {
    parse_deep_link(url)?;
    match accept_input(app, url) {
        Ok(result) => Some(result),
        Err(error) => {
            eprintln!("[license] could not store a license from a link: {error}");
            Some(LicenseActionResult {
                outcome: OUTCOME_INVALID,
                view: current_view(app).unwrap_or_else(|_| unlicensed_view()),
            })
        }
    }
}

fn deliver(app: &AppHandle, url: &str) {
    let Some(result) = apply_deep_link(app, url) else {
        return;
    };
    let state: State<'_, AppState> = app.state();
    state.license.park(result);
    use tauri::Emitter;
    // Payload-free on purpose — see LICENSE_LINK_EVENT.
    let _ = app.emit(LICENSE_LINK_EVENT, ());
}

/// Registers the `futonotes` scheme and starts listening. Called from `setup`,
/// so a link that arrived with the launch is already parked before the webview
/// exists; the shell drains it once it has painted (M1).
pub(crate) fn install(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;

    // An app that was never installed by a package manager (a dev run, an
    // unregistered AppImage) still has to answer its own scheme.
    #[cfg(any(windows, target_os = "linux"))]
    if let Err(error) = app.deep_link().register_all() {
        eprintln!("[license] could not register the futonotes scheme: {error}");
    }

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            deliver(&handle, url.as_str());
        }
    });

    // The plugin parses argv during its own setup, which happens before the
    // listener above exists, so a cold-start link is only visible here.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            deliver(app, url.as_str());
        }
    }
}

/// A second launch carrying a link is routed into the running instance by the
/// single-instance plugin; its argv is the only place that URL appears.
pub(crate) fn handle_single_instance_arguments(app: &AppHandle, arguments: &[String]) {
    use tauri_plugin_deep_link::DeepLinkExt;
    app.deep_link().handle_cli_arguments(arguments.iter());
}

#[tauri::command]
pub async fn license_status(app: AppHandle) -> Result<LicenseView, String> {
    blocking(move || current_view(&app)).await
}

#[tauri::command]
pub async fn license_enter_key(
    app: AppHandle,
    input: String,
) -> Result<LicenseActionResult, String> {
    blocking(move || accept_input(&app, &input)).await
}

#[tauri::command]
pub async fn license_remove(app: AppHandle) -> Result<LicenseView, String> {
    blocking(move || {
        clear_pair(&license_path(&app)?)?;
        Ok(unlicensed_view())
    })
    .await
}

/// Where Buy / Renew and "Lost your key?" go for this build.
///
/// Takes the app handle for the same reason the verdict commands do: the Buy
/// destination is the generated checkout on this environment's pay2 host, and
/// the bundle identifier is the dev/prod split (M3). A dev desktop build
/// therefore opens staging checkout — the environment whose key it verifies
/// against — instead of the production storefront.
#[tauri::command]
pub async fn license_links(app: AppHandle) -> LicenseLinks {
    let config = Environment::for_bundle_id(&app.config().identifier).config();
    LicenseLinks {
        buy: buy_url(config, Platform::Desktop),
        support: SUPPORT_MAILTO.to_string(),
    }
}

#[tauri::command]
pub async fn license_take_pending_link(
    state: State<'_, AppState>,
) -> Result<Option<LicenseActionResult>, String> {
    Ok(state.license.take())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futo_notes_license::{InvalidReason, LicenseDetails};
    use std::sync::atomic::{AtomicU32, Ordering};

    fn scratch(label: &str) -> PathBuf {
        static SEQUENCE: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "futo-notes-license-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn instant(rfc3339: &str) -> OffsetDateTime {
        OffsetDateTime::parse(rfc3339, &time::format_description::well_known::Rfc3339).unwrap()
    }

    fn details() -> LicenseDetails {
        LicenseDetails {
            key: "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78".to_string(),
            product: "futo-notes".to_string(),
            issued_at: instant("2026-01-15T10:30:00Z"),
            expires_at: Some(instant("2029-01-15T10:30:00Z")),
        }
    }

    /// The whole point of storage: what was accepted is what comes back, byte
    /// for byte. base64url is case-sensitive, so an activation that is
    /// "helpfully" normalized on the way through stops verifying.
    #[test]
    fn a_stored_pair_round_trips_unchanged() {
        let directory = scratch("round-trip");
        let path = directory.join(LICENSE_FILE);
        let pair = LicensePair {
            key: "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78".to_string(),
            activation: "v2.aBcD_-eF.gH-iJ_kL".to_string(),
        };

        write_pair(&path, &pair).unwrap();
        let loaded = read_pair(&path);

        std::fs::remove_dir_all(&directory).unwrap();
        assert_eq!(loaded, Some(pair));
    }

    /// Reading is the app's very first license question on every launch, so
    /// "nothing stored" has to be an answer, not an error.
    #[test]
    fn a_missing_file_reads_as_no_license() {
        let directory = scratch("missing");
        let path = directory.join(LICENSE_FILE);

        let loaded = read_pair(&path);

        std::fs::remove_dir_all(&directory).unwrap();
        assert_eq!(loaded, None);
    }

    /// A truncated or hand-edited file must not become a pair that can never
    /// verify — that would render as Unlicensed anyway, but only after a
    /// pointless RSA check on every read.
    #[test]
    fn a_half_written_file_reads_as_no_license() {
        let directory = scratch("half-written");
        let path = directory.join(LICENSE_FILE);
        std::fs::write(&path, r#"{"key":"FN-AB12","activation":"  "}"#).unwrap();

        let loaded = read_pair(&path);

        std::fs::remove_dir_all(&directory).unwrap();
        assert_eq!(loaded, None);
    }

    /// Remove is reversible by re-entering the key and asks for no
    /// confirmation, so it must also be idempotent: pressing it twice, or once
    /// with nothing stored, is success.
    #[test]
    fn removing_a_license_that_was_never_stored_succeeds() {
        let directory = scratch("clear-absent");
        let path = directory.join(LICENSE_FILE);

        assert!(clear_pair(&path).is_ok());

        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn removing_a_stored_license_deletes_the_file() {
        let directory = scratch("clear-present");
        let path = directory.join(LICENSE_FILE);
        write_pair(
            &path,
            &LicensePair {
                key: "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78".to_string(),
                activation: "v2.a.b".to_string(),
            },
        )
        .unwrap();

        clear_pair(&path).unwrap();
        let loaded = read_pair(&path);

        std::fs::remove_dir_all(&directory).unwrap();
        assert_eq!(loaded, None);
    }

    /// "Supporter since {year}" and "Valid until {date}" both come from the
    /// payload, so the row cannot render unless both timestamps cross the IPC
    /// boundary in a form the frontend can parse.
    #[test]
    fn a_licensed_state_carries_both_timestamps() {
        let view = view_of(&LicenseState::Licensed(details()));

        assert_eq!(view.state, "licensed");
        assert_eq!(view.issued_at.as_deref(), Some("2026-01-15T10:30:00Z"));
        assert_eq!(view.expires_at.as_deref(), Some("2029-01-15T10:30:00Z"));
    }

    /// An expired license is kept and still says "Supporter since", so it must
    /// keep its dates too — the Expired row renders both.
    #[test]
    fn an_expired_state_keeps_its_dates() {
        let view = view_of(&LicenseState::Expired(details()));

        assert_eq!(view.state, "expired");
        assert_eq!(view.issued_at.as_deref(), Some("2026-01-15T10:30:00Z"));
        assert_eq!(view.expires_at.as_deref(), Some("2029-01-15T10:30:00Z"));
    }

    /// A perpetual license has no expiry, and the row must not invent one.
    #[test]
    fn a_perpetual_license_reports_no_expiry() {
        let mut perpetual = details();
        perpetual.expires_at = None;

        let view = view_of(&LicenseState::Licensed(perpetual));

        assert_eq!(view.state, "licensed");
        assert_eq!(view.expires_at, None);
    }

    /// `InvalidReason` is diagnostic only: a stored pair that no longer
    /// verifies must look exactly like no license, never leak a reason.
    #[test]
    fn an_invalid_state_is_indistinguishable_from_unlicensed() {
        let view = view_of(&LicenseState::Invalid(InvalidReason::SignatureMismatch));

        assert_eq!(view, unlicensed_view());
        assert_eq!(view.state, "unlicensed");
    }

    /// These strings are the IPC contract: the shell switches on them to pick a
    /// state to render and a toast to show, and a `Record<LicenseOutcome, …>`
    /// lookup in TypeScript answers `undefined` for a name that drifted. Every
    /// other test here compares against the constants, so renaming a constant's
    /// VALUE would leave them all green — this is the one that goes red (M11).
    #[test]
    fn the_wire_names_the_shell_switches_on_are_pinned() {
        assert_eq!(STATE_UNLICENSED, "unlicensed");
        assert_eq!(STATE_LICENSED, "licensed");
        assert_eq!(STATE_EXPIRED, "expired");
        assert_eq!(OUTCOME_ACTIVATED, "activated");
        assert_eq!(OUTCOME_INVALID, "invalid");
        assert_eq!(OUTCOME_OFFLINE, "offline");
        assert_eq!(LICENSE_LINK_EVENT, "license:link");
    }

    /// The spec gives 404 and a failed verification the SAME message, and
    /// reserves the "connect to the internet" message for a request that did
    /// not complete. Getting this mapping backwards would tell a user with a
    /// typo'd key to check their network.
    #[test]
    fn a_rejected_key_and_a_missing_key_share_one_message() {
        assert_eq!(
            outcome_of_error(&EnterKeyError::Invalid(InvalidReason::WrongProduct)),
            OUTCOME_INVALID
        );
        assert_eq!(outcome_of_error(&EnterKeyError::NotFound), OUTCOME_INVALID);
        assert_eq!(
            outcome_of_error(&EnterKeyError::Transport(TransportError::new("dns"))),
            OUTCOME_OFFLINE
        );
    }

    /// The inbox exists so a cold-start link is toasted exactly once. Two
    /// drains returning the same outcome would double-toast; zero would lose it.
    #[test]
    fn a_parked_link_outcome_is_delivered_exactly_once() {
        let inbox = LicenseLinkInbox::default();
        let result = LicenseActionResult {
            outcome: OUTCOME_ACTIVATED,
            view: unlicensed_view(),
        };

        assert_eq!(inbox.take(), None);
        inbox.park(result.clone());
        assert_eq!(inbox.take(), Some(result));
        assert_eq!(inbox.take(), None);
    }

    /// The regression this pins: a link handled while the app was RUNNING used
    /// to stay parked after its toast, so the next launch drained it and showed
    /// the same message again — an "isn't valid" toast on a licensed app
    /// (observed in QA 2026-09-09). Draining is the only read, so one link can
    /// only ever be reported once.
    #[test]
    fn a_drained_outcome_does_not_survive_to_the_next_launch() {
        let inbox = LicenseLinkInbox::default();
        inbox.park(LicenseActionResult {
            outcome: OUTCOME_INVALID,
            view: unlicensed_view(),
        });

        assert!(inbox.take().is_some(), "the shell drains the outcome once");

        // What a relaunch would see.
        assert_eq!(inbox.take(), None);
    }

    /// The most recent link is the one that matters: an outcome nobody drained
    /// must not shadow a newer one.
    #[test]
    fn a_second_link_replaces_an_undrained_outcome() {
        let inbox = LicenseLinkInbox::default();
        inbox.park(LicenseActionResult {
            outcome: OUTCOME_INVALID,
            view: unlicensed_view(),
        });
        inbox.park(LicenseActionResult {
            outcome: OUTCOME_ACTIVATED,
            view: unlicensed_view(),
        });

        assert_eq!(inbox.take().unwrap().outcome, OUTCOME_ACTIVATED);
    }
}
