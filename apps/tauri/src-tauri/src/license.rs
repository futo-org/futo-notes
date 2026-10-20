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
    buy_url, enter_license_key, evaluate, license_includes as core_license_includes,
    parse_deep_link, ActivationTransport, BuySource, EnterKeyError, Environment, HttpResponse,
    LicenseInclusion, LicensePair, LicenseState, LicenseStatus, OffsetDateTime, Platform,
    TransportError, SUPPORT_MAILTO,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::application_state::AppState;
use crate::background_tasks::blocking;

/// The stored pair, next to the other per-build desktop state in the app data
/// dir. Never in the vault (it would sync and show up in the note list) and
/// never in the OS keyring (it is not a secret — it is a receipt).
mod storage;

use storage::{clear_pair, license_path, read_pair, write_pair};

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
    /// What this state includes beyond the card, as camelCase names
    /// (`appIcon`) — the crate's `license_includes` answer. Desktop renders
    /// nothing from it (no picker); it is projected so the TS shell holds no
    /// copy of the rule.
    pub includes: Vec<&'static str>,
    /// `issued_at` — the source of the card's "Licensed since {date}". `None`
    /// for a v1 activation, which carries no purchase time: the row renders
    /// blank and the ambient label is dropped, never a stand-in date.
    pub issued_at: Option<String>,
    /// `expires_at`, or `null` for a perpetual license.
    pub expires_at: Option<String>,
    /// The stored license key, in the crate's normalized form — the same
    /// string that is on disk. The card shows it masked and reveals it on
    /// request, so it crosses here rather than being read out of the license
    /// file by a shell. `None` whenever the state is Unlicensed, which
    /// includes a stored pair that no longer verifies.
    pub key: Option<String>,
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
        LicenseState::Licensed(details) | LicenseState::Expired(details) => LicenseView {
            state: state_name(state.status()),
            includes: includes_of(state.status()),
            issued_at: details.issued_at.and_then(rfc3339),
            expires_at: details.expires_at.and_then(rfc3339),
            key: Some(details.key.clone()),
        },
        LicenseState::Invalid(_) => unlicensed_view(),
    }
}

fn unlicensed_view() -> LicenseView {
    LicenseView {
        state: state_name(LicenseStatus::Unlicensed),
        includes: includes_of(LicenseStatus::Unlicensed),
        issued_at: None,
        expires_at: None,
        key: None,
    }
}

/// The wire name of a status; the pairing with the crate's enum is the only
/// mapping here.
fn state_name(status: LicenseStatus) -> &'static str {
    match status {
        LicenseStatus::Unlicensed => STATE_UNLICENSED,
        LicenseStatus::Licensed => STATE_LICENSED,
        LicenseStatus::Expired => STATE_EXPIRED,
    }
}

fn includes_of(status: LicenseStatus) -> Vec<&'static str> {
    core_license_includes(status)
        .into_iter()
        .map(|inclusion| match inclusion {
            LicenseInclusion::AppIcon => "appIcon",
        })
        .collect()
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
            futo_notes_core::log_to_stderr!(
                "[license] could not store a license from a link: {error}"
            );
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
        futo_notes_core::log_to_stderr!(
            "[license] could not register the futonotes scheme: {error}"
        );
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
        buy: buy_url(config, Platform::Desktop, BuySource::LicenseCard),
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
mod tests;
