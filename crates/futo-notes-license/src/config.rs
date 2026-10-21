//! Baked-in constants and the dev/prod split that selects between them.

/// The product name inside a v2 activation payload. A license minted for any
/// other product — a Grayjay license, say — is Invalid here.
///
/// **This is not the checkout slug.** [`CHECKOUT_PRODUCT_SLUG`] is a different
/// string for a different job, and the two are deliberately not unified: this
/// one is compared against `payload.product` on bytes a server already signed,
/// so changing it invalidates real licenses, while the other is only a URL path
/// segment. Never "tidy" one into the other.
pub const PRODUCT_SLUG: &str = "futo-notes";

/// The product's slug in the FUTOpay storefront, i.e. the second path segment
/// of every `/checkout/polar/{org}/{product}/…` URL.
///
/// It is `futo-notes-license` — the storefront's own links say so, and
/// `/checkout/polar/futo-notes/futo-notes-license/price` answers with the real
/// product, "FUTO Notes License", non-recurring (observed on
/// `staging-pay2.futo.org` 2026-09-10; the amount is Polar's business and is
/// deliberately not written down here). The `futo-notes` slug this crate first
/// shipped names no product there: its `/price` answers
/// `{"detail":"Product not found: futo-notes"}` and `checkout-ready` serves the
/// checkout shell with nothing in it, so a buyer reached a page that could
/// never take their money. That is why it is a constant of its own rather than
/// [`PRODUCT_SLUG`] reused: the payload field and the URL segment happened to
/// read the same and are not the same thing.
pub const CHECKOUT_PRODUCT_SLUG: &str = "futo-notes-license";

/// The URL scheme all three shells register.
pub const DEEP_LINK_SCHEME: &str = "futonotes";

/// The only deep-link host this app defines. Anything else is ignored silently.
pub const DEEP_LINK_HOST: &str = "license";

/// The FUTOpay license-key alphabet: no I, L, O, or 0, so a key can be read
/// aloud and typed back.
pub const KEY_ALPHABET: &str = "ABCDEFGHJKMNPQRSTUVWXYZ123456789";

/// The FUTOpay organization that sells this product. Distinct from
/// [`PRODUCT_SLUG`] even though the two read the same — one is the Polar org,
/// the other the product field inside an activation — and distinct again from
/// [`CHECKOUT_PRODUCT_SLUG`], which is what the checkout path names alongside
/// this org.
pub const ORG_SLUG: &str = "futo-notes";

/// The iOS App Store-only purchase (ADR-0009): one non-consumable, Family
/// Sharing off, verified by StoreKit on the device. No server ever sees it.
pub const APP_STORE_PRODUCT_ID: &str = "com.futo.notes.license";

/// Where "Lost your key?" goes. There is no in-app restore flow.
pub const SUPPORT_MAILTO: &str = "mailto:support@futo.tech";

/// What a dev build's bundle/package id ends with (`com.futo.notes.dev`).
pub const DEV_BUNDLE_ID_SUFFIX: &str = ".dev";

const PRODUCTION_PAY2_BASE_URL: &str = "https://pay2.futo.org";
const STAGING_PAY2_BASE_URL: &str = "https://staging-pay2.futo.org";

/// The storefront's address as a person types it, for builds that may name the
/// website but not link to it ([`PurchaseSurface::NameWebsite`]). Production is
/// `pay.futo.org`, which serves the same storefront as `pay2.futo.org` and is
/// shorter to read off a phone (@justin 2026-10-19). Staging has no short
/// alias, so a `.dev` build names its own host: never production (M3).
const PRODUCTION_WEBSITE_ADDRESS: &str = "pay.futo.org";
const STAGING_WEBSITE_ADDRESS: &str = "staging-pay2.futo.org";

/// The real FUTO Notes **production** org public key (SHA-256 of this DER
/// SubjectPublicKeyInfo is `2034d795…aa68`, pinned by
/// `the_production_key_is_the_real_production_org_key` below).
///
/// Read from the live endpoint
/// `GET https://pay2.futo.org/checkout/polar/futo-notes/activation/public-key`
/// on 2026-09-22 — the authority, for the same reason as the staging key below:
/// FUTOpay generates an org's pair at org creation and never replaces it. On
/// that date the 1Password `prod-polar-orgs-futo-notes-pubk` / `-privk` pair
/// matched the endpoint byte for byte, unlike staging's. Its private half
/// lives only in the FUTOpay production deployment and 1Password — never in
/// this repo, and no production-signed activation is ever committed: a v1
/// activation is a working license for anyone who holds it.
///
/// Until 2026-09-22 this was a fail-closed placeholder whose private half was
/// never written down, because production had no `futo-notes` org.
pub const PRODUCTION_PUBLIC_KEY_BASE64: &str = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAme5jXh33xk7PYAysQF3ZeV49wjOdsQktbGdTaLUQFJWMNYnZsL//0Z9vxSZ9GiuljUMJG7kUmcmNyxcIf8WWs2CbPfz/VEf32n65zXAr76kxVx730Bcr3CWBTiK8bO5E8XXGOLpkHWl0KMNOYe6u4IFX29CKQbnOBrbBcc661y1uaiRHqaocf4O0W8sLX2qLHD/UcRyJZk6Ink3wGAcZmP176YT6K9hvMIsrCSQHTv8g5+zq0rFN3qqUKWYC80N2u/GDXbmybP/UsVReAped5pnoYmy0Af/pIAzE8735DU4Y1P/jM0I3AYAtzdQsST/ycjZRLQloaEN5ED2gFse87QIDAQAB";

/// The real FUTO Notes **staging** org public key (SHA-256 of this DER
/// SubjectPublicKeyInfo is `fca4b6a4…29a23`, pinned by
/// `the_staging_key_is_the_real_staging_org_key` below).
///
/// **The deployment generates this pair; nothing installs one into it.** FUTOpay
/// mints an org's RSA pair in `initialize_organizations` the moment the org row
/// is first inserted, and `auto_upsert_organization` never overwrites the two
/// key columns afterwards, so the key is fixed at org creation and no redeploy
/// moves it. `manifest-inventory` does inject
/// `POLAR__ORGS__FUTO_NOTES__PRIVATE_KEY` from 1Password, but no branch of
/// lib-polar reads that variable outside its test suite — which is why this
/// constant held an uninstalled 1Password pair (`ca4a8698…`) until 2026-09-11
/// and every real staging license verified as Invalid. The authority is
/// `GET {pay2}/checkout/polar/futo-notes/activation/public-key`; FUTO Music
/// bakes both of its keys straight from the same endpoints. If lib-polar is
/// ever fixed to honor the manifest, this constant moves back — one line here
/// plus re-minted fixtures.
///
/// Its private half lives only in the FUTOpay staging deployment (and belongs in
/// 1Password, whose `staging-polar-orgs-futo-notes-privk` field is a different,
/// never-deployed key) — never in this repo, so a staging license can only be
/// minted by staging or by someone holding that key. `tests/conformance/
/// license.json` keeps its self-contained test-only pair (the conformance suite
/// reads the key out of the fixture, never from here), and everything that has
/// to verify on a real `.dev` build — the native `LicenseFixture` pair and the
/// FFI contract tests — is signed by this key instead. Re-mint those with
/// `node scripts/gen-license-fixture.mjs --staging`.
pub const STAGING_PUBLIC_KEY_BASE64: &str = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1ojmpH9aYrzxzMqzkxHhTzxT4ZKmZTCy6kamwvDRGWKD6mRhbrAfD0d4HoiKPMDif5U2s4kKmJcbBk5PkqhbIdT7gIo/EUwCQpcd0waE8aRE0jS9+U+AWn0GaKQb/86/lrVBpSWHspSeJURxMP0PDDw86NUOPhJmgAxg93P+N/zIUoZ6flJFarIDM57FVgraS9OyH6zu9V3uDpKwKysDnTYZoLHevF9vCuQffoGYOh0s95XPyzQxzcLqkD1lrfAZcp0yInzPnmLAtJ/l6/CFkcb11tWcUZ7zBOUa6GdpBfccbF2PF79gjr4lvaQMZH4ObrAqycwqrfcLyrQYOQaDwQIDAQAB";

/// The `FUTO_LICENSE_ENV` build flag: `staging` or `production` (`prod`),
/// read at **compile time**, so it has to be set on the build that compiles
/// this crate (the FFI build for iOS/Android, the Tauri build for desktop):
///
/// ```sh
/// FUTO_LICENSE_ENV=production just ios-native   # a .dev app on the prod org
/// FUTO_LICENSE_ENV=staging just tauri-build     # a release bundle on staging
/// ```
///
/// When set it beats the bundle id, which is the whole point: it lets any
/// build — a `.dev` app with its separate data root, or a release bundle —
/// run a real purchase against either org. Unset (every CI and store build),
/// the bundle-id split below decides, exactly as before. Any other value
/// fails the build rather than silently picking one.
pub const LICENSE_ENV_OVERRIDE: Option<Environment> = match option_env!("FUTO_LICENSE_ENV") {
    None => None,
    Some(value) => match Environment::parse_flag(value) {
        Some(environment) => Some(environment),
        None => panic!("FUTO_LICENSE_ENV must be `staging` or `production`"),
    },
};

/// Which FUTOpay org this build talks to and verifies against.
///
/// A dev build can never verify or fetch a production license, and vice versa
/// (AGENTS.md M3). The two halves are independent on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Environment {
    /// Release builds: `com.futo.notes`, the production org key, pay2.futo.org.
    Production,
    /// Dev builds: the `.dev` bundle/package ids, the staging org key,
    /// staging-pay2.futo.org.
    Staging,
}

impl Environment {
    /// The environment this build talks to: the [`LICENSE_ENV_OVERRIDE`] flag
    /// when the build set one, otherwise whatever its bundle/package id says.
    ///
    /// The `.dev` suffix IS the default dev/prod split on all three platforms
    /// (M3), so this is the one selector every shell can use. It deliberately
    /// replaced a `cfg!(debug_assertions)` version: the native shells build
    /// the FFI with `release-ffi` for their dev apps too, so a compile-profile
    /// test would have quietly put a `.dev` phone build on the production key.
    ///
    /// An id this crate does not recognize is Production — the fail-safe
    /// direction, since the production key cannot verify a staging license.
    pub fn for_bundle_id(bundle_id: &str) -> Self {
        LICENSE_ENV_OVERRIDE.unwrap_or_else(|| Self::from_bundle_suffix(bundle_id))
    }

    /// The bundle-id split alone, without the build flag — what
    /// [`Environment::for_bundle_id`] falls back to, and what the conformance
    /// fixture's bundle-id mapping pins.
    pub fn from_bundle_suffix(bundle_id: &str) -> Self {
        if bundle_id.trim().ends_with(DEV_BUNDLE_ID_SUFFIX) {
            Environment::Staging
        } else {
            Environment::Production
        }
    }

    const fn parse_flag(value: &str) -> Option<Self> {
        match value.as_bytes() {
            b"staging" => Some(Environment::Staging),
            b"production" | b"prod" => Some(Environment::Production),
            _ => None,
        }
    }

    /// The storefront address a [`PurchaseSurface::NameWebsite`] build shows
    /// as plain text: no scheme, never a link.
    pub const fn website_address(self) -> &'static str {
        match self {
            Environment::Production => PRODUCTION_WEBSITE_ADDRESS,
            Environment::Staging => STAGING_WEBSITE_ADDRESS,
        }
    }

    /// The key and base URL this environment verifies and activates against.
    pub const fn config(self) -> LicenseConfig<'static> {
        match self {
            Environment::Production => LicenseConfig {
                public_key_base64: PRODUCTION_PUBLIC_KEY_BASE64,
                pay2_base_url: PRODUCTION_PAY2_BASE_URL,
            },
            Environment::Staging => LicenseConfig {
                public_key_base64: STAGING_PUBLIC_KEY_BASE64,
                pay2_base_url: STAGING_PAY2_BASE_URL,
            },
        }
    }
}

/// Everything the license rules need from the outside world that is not the
/// clock or the transport: which public key verifies an activation, and which
/// pay2 host answers the one activation request.
///
/// Shells get this from [`Environment::config`]. It is spelled out as a struct
/// so the conformance fixture can point the same rules at a test-only key pair
/// without a second code path.
#[derive(Debug, Clone, Copy)]
pub struct LicenseConfig<'a> {
    /// Base64 (or PEM) SubjectPublicKeyInfo for the org's RSA public key.
    pub public_key_base64: &'a str,
    /// Origin of the FUTOpay instance, with no trailing slash.
    pub pay2_base_url: &'a str,
}

/// Attribution only: which client sent the buyer to checkout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Desktop,
    Ios,
    Android,
}

impl Platform {
    const fn slug(self) -> &'static str {
        match self {
            Platform::Desktop => "desktop",
            Platform::Ios => "ios",
            Platform::Android => "android",
        }
    }
}

mod links;
pub use links::{
    activation_url, buy_url, license_link_out, license_purchase_surface, BuySource, Distribution,
    PurchaseSurface,
};

#[cfg(test)]
mod tests;
