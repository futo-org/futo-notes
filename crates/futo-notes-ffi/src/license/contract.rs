//! The UniFFI license contract: what iOS and Android call, and what they get
//! back. Records and enums only — no copy, no storage, no platform branching.

use futo_notes_license::{
    app_icons_every_install_has as core_app_icons_every_install_has, buy_url, enter_license_key,
    evaluate, evidence_includes as core_evidence_includes,
    license_includes as core_license_includes, license_plate as core_license_plate,
    license_purchase_surface as core_license_purchase_surface, parse_deep_link,
    ActivationTransport, BuySource as CoreBuySource, Distribution, EnterKeyError, Environment,
    LicenseConfig, LicenseEvidence as CoreLicenseEvidence,
    LicenseInclusion as CoreLicenseInclusion, LicensePlate as CoreLicensePlate, LicenseState,
    LicenseStatus as CoreLicenseStatus, OffsetDateTime, Platform, PurchaseSurface, TransportError,
    APP_STORE_PRODUCT_ID, DEEP_LINK_SCHEME, SUPPORT_MAILTO,
};

use super::transport::Pay2Transport;

mod activation;
mod evidence;
mod links;

#[cfg(test)]
use activation::{enter_key_with, evaluate_at, handle_deep_link_with, unlicensed};
pub use activation::{license_enter_key, license_evaluate, license_handle_deep_link};
pub use evidence::{
    license_app_icons_every_install_has, license_app_store_product_id, license_evidence_includes,
    license_evidence_row_actions, license_includes, license_plate, LicenseEvidence,
    LicenseInclusion, LicensePlate,
};
pub use links::{
    license_deep_link_scheme, license_link_out, license_links, license_purchase_surface,
    license_row_actions, license_surface_row_actions, BuySource, LicenseAction,
    LicenseDistribution, LicenseLinks, LicensePlatform, LicensePurchaseSurface,
};

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
    /// `issued_at` — the source of the card's "Licensed since {date}". `None`
    /// for a v1 activation, which carries no purchase time at all: the row is
    /// then rendered blank rather than showing a stand-in date.
    pub issued_at_millis: Option<i64>,
    /// `expires_at`, or `None` for a perpetual license. A shell must not
    /// invent a date when this is absent; the row drops the clause instead.
    pub expires_at_millis: Option<i64>,
    /// The stored license key, in the crate's normalized (trimmed, uppercased)
    /// form — the same string the shell has on disk. The card shows it masked
    /// and reveals it on request, so it crosses here rather than each shell
    /// reaching back into its own storage for display. `None` whenever the
    /// status is Unlicensed, which includes a stored pair that no longer
    /// verifies.
    pub key: Option<String>,
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

impl From<CoreLicenseStatus> for LicenseStatus {
    fn from(status: CoreLicenseStatus) -> Self {
        match status {
            CoreLicenseStatus::Unlicensed => LicenseStatus::Unlicensed,
            CoreLicenseStatus::Licensed => LicenseStatus::Licensed,
            CoreLicenseStatus::Expired => LicenseStatus::Expired,
        }
    }
}

impl From<LicenseStatus> for CoreLicenseStatus {
    fn from(status: LicenseStatus) -> Self {
        match status {
            LicenseStatus::Unlicensed => CoreLicenseStatus::Unlicensed,
            LicenseStatus::Licensed => CoreLicenseStatus::Licensed,
            LicenseStatus::Expired => CoreLicenseStatus::Expired,
        }
    }
}

#[cfg(test)]
mod tests;
