//! The paid client license: the one owner of every license rule.
//!
//! Behavioral truth is `docs/spec/license.md`. FUTO Notes is free to use; a
//! license unlocks nothing functional. It removes the ambient "Unlicensed"
//! label and shows "Supporter since {year}". Nothing in this crate gates a
//! feature, and nothing ever should.
//!
//! # What this crate owns
//!
//! Input-shape recognition, FUTOpay activation parsing and RSA verification —
//! both the v1 bare signature and the v2 envelope — the Licensed/Expired/Invalid
//! predicate, deep-link parsing, the Buy and support URLs, and the single
//! activation request. Shells own only UI, URL scheme registration, and
//! preference storage — no license rule is written again in Swift, Kotlin, or
//! TypeScript (AGENTS.md M6).
//!
//! # What it deliberately does not own
//!
//! * **Storage.** [`AcceptedLicense::pair`] is two plain strings; where they
//!   live is the shell's business (app-private preferences, inside the
//!   dev/prod-split data location, never the vault or the keyring).
//! * **The clock.** Every predicate takes `now`.
//! * **HTTP.** The one request goes through an injected [`ActivationTransport`].
//! * **Copy.** Errors are typed; the strings live in `languages/en.json`.
//!
//! # Network
//!
//! Zero, except inside [`enter_license_key`] and only when the user typed a
//! bare key: exactly one `GET`, no retry, no launch check, no polling, no
//! background re-attempt. Verifying a `key/activation` pair or a deep link is
//! fully offline.
//!
//! # Using it from a shell
//!
//! ```no_run
//! use futo_notes_license::{
//!     enter_license_key, evaluate, Environment, LicensePair, LicenseState, OffsetDateTime,
//! };
//! # fn demo(transport: &dyn futo_notes_license::ActivationTransport, stored: Option<LicensePair>) {
//! // The `.dev` id suffix is the dev/prod split on every platform (M3).
//! let config = Environment::for_bundle_id("com.futo.notes.dev").config();
//! let now = OffsetDateTime::now_utc();
//!
//! // Render the License row from whatever is stored.
//! // `issued_at` is absent for a v1 activation, and the clause is then dropped
//! // rather than filled in with a stand-in date.
//! let row = match stored.as_ref().map(|pair| evaluate(pair, config, now)) {
//!     Some(LicenseState::Licensed(details)) => match details.issued_at {
//!         Some(issued_at) => format!("Licensed since {issued_at}"),
//!         None => "Licensed".to_string(),
//!     },
//!     Some(LicenseState::Expired(details)) => format!("Expired {:?}", details.expires_at),
//!     Some(LicenseState::Invalid(_)) | None => "Unlicensed".to_string(),
//! };
//! # let _ = row;
//!
//! // Entry (and the deep link) is one atomic call.
//! if let Ok(accepted) = enter_license_key("FN-AB12-…", config, now, transport) {
//!     // persist accepted.pair.key and accepted.pair.activation
//!     # let _ = accepted;
//! }
//! # }
//! ```

mod activation;
mod config;
mod enter;
mod input;
mod key;
mod state;

pub use config::{
    activation_url, buy_url, Environment, LicenseConfig, Platform, CHECKOUT_PRODUCT_SLUG,
    DEEP_LINK_HOST, DEEP_LINK_SCHEME, DEV_BUNDLE_ID_SUFFIX, KEY_ALPHABET, ORG_SLUG,
    PRODUCTION_PUBLIC_KEY_BASE64, PRODUCT_SLUG, STAGING_PUBLIC_KEY_BASE64, SUPPORT_MAILTO,
};
pub use enter::{
    enter_license_key, AcceptedLicense, ActivationTransport, EnterKeyError, HttpResponse,
    TransportError,
};
pub use input::{parse_deep_link, recognize_input, LicenseInput, LicensePair};
pub use key::{is_valid_license_key, normalize_license_key};
pub use state::{evaluate, InvalidReason, LicenseDetails, LicenseState};

/// Re-exported so shells and the FFI projection do not have to agree on a
/// `time` version to speak to this crate.
pub use time::OffsetDateTime;
