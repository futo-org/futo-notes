//! The native shells' projection of the paid client license.
//!
//! Every license *rule* lives in `futo-notes-license` (docs/spec/license.md).
//! This module owns only what that crate deliberately pushed out to a shell and
//! what a Swift or Kotlin shell should not own either: the clock, the one
//! activation request, and the shape of the answers. Storage stays with the
//! shell — two plain strings in `UserDefaults` / `SharedPreferences`, inside
//! the dev/prod-split app sandbox (M3).
//!
//! iOS and Android consume this same surface unchanged. Nothing here is
//! iOS-shaped: `bundle_id` is the environment selector on both platforms
//! (`Environment::for_bundle_id`, never a compile profile), and every string
//! that crosses is either data or an RFC 3339 timestamp — never copy. The
//! catalog entries under `license.` in `languages/en.json` are the copy.
mod contract;
mod transport;

pub use contract::{
    license_deep_link_scheme, license_enter_key, license_evaluate, license_handle_deep_link,
    license_links, license_row_actions, LicenseAcceptance, LicenseAction, LicenseError,
    LicenseLinkOutcome, LicenseLinks, LicensePair, LicensePlatform, LicenseStatus, LicenseView,
};
