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

/// Where "Lost your key?" goes. There is no in-app restore flow.
pub const SUPPORT_MAILTO: &str = "mailto:support@futo.tech";

/// What a dev build's bundle/package id ends with (`com.futo.notes.dev`).
pub const DEV_BUNDLE_ID_SUFFIX: &str = ".dev";

const PRODUCTION_PAY2_BASE_URL: &str = "https://pay2.futo.org";
const STAGING_PAY2_BASE_URL: &str = "https://staging-pay2.futo.org";

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
    /// An id this crate does not recognise is Production — the fail-safe
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

/// Whether this distribution may offer checkout in the current storefront.
/// An unknown iOS storefront cannot offer an external purchase link.
pub fn license_link_out(
    platform: Platform,
    storefront_country: Option<&str>,
    build_allows: bool,
) -> bool {
    match platform {
        Platform::Ios => build_allows && storefront_country == Some("USA"),
        Platform::Android => build_allows,
        Platform::Desktop => true,
    }
}

/// The Buy / Renew destination: this environment's **generated checkout**,
/// opened in the browser surface permitted by the distribution.
///
/// There is no `pay.futo.tech/futo-notes` landing page and there will not be
/// one (product decision 2026-09-10). The one-segment product URL exists only
/// on an undeployed lib-polar branch, and all it ever did was redirect to
/// `checkout-ready` — so this crate names that destination directly, which is
/// both what is deployed today and what the landing page would have resolved
/// to. The sibling `/price` and `/info` routes on the same path are JSON APIs
/// for the in-app sheets (#158, #159), not browser destinations.
///
/// It is built from [`LicenseConfig::pay2_base_url`] rather than a single
/// constant so that it is environment-split like the verification key and the
/// activation host (AGENTS.md M3): a `.dev` build reaches staging checkout and
/// a release build reaches production. A single constant meant a dev build's
/// Buy button could only ever open production.
///
/// `success` is `redirect-to-organization-page`, the storefront's own marker
/// (observed on `staging-pay2.futo.org` 2026-09-10). The buyer pays in the
/// **system browser**, so the page FUTOpay sends them to after paying must be
/// one a human can read: this marker makes the checkout-status route return its
/// key-page template, and the buyer lands on the license key page — the key as
/// HTML, plus an Activate button that fires this app's
/// `futonotes://license/{key}/{activation}` deep link. An empty `success`
/// instead marks the purchase client-driven, which is the JSON contract of the
/// in-app-WebView clients this app never runs (every platform links out,
/// ADR-0003) — observed on staging 2026-09-11, the buyer finished paying and
/// their browser showed them the raw activation JSON. The parameter must also
/// simply be present: the deployed FUTOpay 422s a `checkout-ready` without it.
/// `platform` is attribution only and never changes price, product, or
/// entitlement.
pub fn buy_url(config: LicenseConfig<'_>, platform: Platform) -> String {
    format!(
        "{}/checkout/polar/{ORG_SLUG}/{CHECKOUT_PRODUCT_SLUG}/checkout-ready?platform={}&success=redirect-to-organization-page",
        config.pay2_base_url.trim_end_matches('/'),
        platform.slug()
    )
}

/// The one endpoint this crate ever calls, and only from
/// [`crate::enter_license_key`] when the user entered a bare key.
pub fn activation_url(config: LicenseConfig<'_>, key: &str) -> String {
    format!(
        "{}/api/v1/activate/{}",
        config.pay2_base_url.trim_end_matches('/'),
        percent_encode_path_segment(key)
    )
}

/// RFC 3986 unreserved-only percent-encoding for one path segment.
///
/// A license key is `[A-Z0-9-]` by construction, so this is the identity
/// function for every real key. It exists so a hand-built or future key shape
/// can never smuggle a `/`, a space, or a `?` into the request path.
///
/// Hand-rolled on purpose, unlike the SPKI reader above: `percent-encoding`
/// ships no path-segment set, so using it would still mean authoring the
/// `AsciiSet` here — and its nearest ready-made set, `NON_ALPHANUMERIC`, encodes
/// `-`, which every real license key is full of. The library would move the
/// policy, not remove it, while making a silent URL change easy.
fn percent_encode_path_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkout_availability_follows_storefront_and_distribution() {
        for country in [None, Some("FRA"), Some("JPN"), Some(""), Some("usa")] {
            assert!(!license_link_out(Platform::Ios, country, true));
        }
        assert!(license_link_out(Platform::Ios, Some("USA"), true));
        assert!(!license_link_out(Platform::Ios, Some("USA"), false));
        assert!(license_link_out(Platform::Android, None, true));
        assert!(!license_link_out(Platform::Android, Some("USA"), false));
        assert!(license_link_out(Platform::Desktop, None, false));
    }

    /// CRITICAL. The staging constant is the real FUTO Notes staging org key,
    /// and this is its identity: SHA-256 over the DER SubjectPublicKeyInfo.
    ///
    /// Every staging-signed artifact in the repo — the iOS and Android
    /// `LicenseFixture` pair, the FFI contract tests' activations — was minted
    /// against exactly this key and verifies against nothing else. Swapping the
    /// constant for another valid key would leave every one of those tests
    /// failing with a signature mismatch and no explanation; this fails first,
    /// naming what actually changed. The fingerprint is recorded independently
    /// in 1Password and in issue #157.
    #[test]
    fn the_staging_key_is_the_real_staging_org_key() {
        use base64::Engine as _;

        let der = base64::engine::general_purpose::STANDARD
            .decode(STAGING_PUBLIC_KEY_BASE64)
            .expect("the staging constant is standard base64");
        let digest = ring::digest::digest(&ring::digest::SHA256, &der);
        let fingerprint: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect();

        assert_eq!(
            fingerprint, "fca4b6a4c48cf730aa5b7cbf7c59145eda30dee9e96414eb9c378dd202e29a23",
            "STAGING_PUBLIC_KEY_BASE64 is not the FUTO Notes staging org key — \
             if this was deliberate, re-mint every staging-signed fixture with \
             `node scripts/gen-license-fixture.mjs --staging` and update this \
             fingerprint in the same commit"
        );
    }

    /// CRITICAL. The production constant is the real FUTO Notes production org
    /// key — the one every shipped release build verifies against. Unlike the
    /// staging key, nothing in the repo is signed by it (no production-signed
    /// activation is ever committed), so without this pin a wrong key would
    /// pass every test and show every paying user Unlicensed.
    #[test]
    fn the_production_key_is_the_real_production_org_key() {
        use base64::Engine as _;

        let der = base64::engine::general_purpose::STANDARD
            .decode(PRODUCTION_PUBLIC_KEY_BASE64)
            .expect("the production constant is standard base64");
        let digest = ring::digest::digest(&ring::digest::SHA256, &der);
        let fingerprint: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect();

        assert_eq!(
            fingerprint, "2034d795d4c4201da026791017ef12be4b8834372af8bf46cf064371b7f6aa68",
            "PRODUCTION_PUBLIC_KEY_BASE64 is not the FUTO Notes production org key \
             served by pay2.futo.org/checkout/polar/futo-notes/activation/public-key"
        );
    }

    #[test]
    fn a_dev_bundle_id_never_lands_on_the_production_key() {
        assert_eq!(
            Environment::from_bundle_suffix("com.futo.notes.dev"),
            Environment::Staging
        );
        assert_eq!(
            Environment::from_bundle_suffix("com.futo.notes"),
            Environment::Production
        );
        // Not a suffix match on the word, and not fooled by stray whitespace.
        assert_eq!(
            Environment::from_bundle_suffix("com.futo.notes.development"),
            Environment::Production
        );
        assert_eq!(
            Environment::from_bundle_suffix(" com.futo.notes.dev "),
            Environment::Staging
        );
    }

    #[test]
    fn the_build_flag_beats_the_bundle_id_and_only_when_set() {
        let expected =
            |bundle_id| LICENSE_ENV_OVERRIDE.unwrap_or(Environment::from_bundle_suffix(bundle_id));
        for bundle_id in ["com.futo.notes", "com.futo.notes.dev"] {
            assert_eq!(Environment::for_bundle_id(bundle_id), expected(bundle_id));
        }
        assert_eq!(
            Environment::parse_flag("staging"),
            Some(Environment::Staging)
        );
        assert_eq!(
            Environment::parse_flag("production"),
            Some(Environment::Production)
        );
        assert_eq!(
            Environment::parse_flag("prod"),
            Some(Environment::Production)
        );
        assert_eq!(Environment::parse_flag("Production"), None);
        assert_eq!(Environment::parse_flag(""), None);
    }

    /// The literal URL, written out rather than assembled from the constants
    /// this function already uses — a test that rebuilds the format string
    /// agrees with any typo in it. This exact path was fetched from
    /// `staging-pay2.futo.org` on 2026-09-10 and served the real product;
    /// swapping `futo-notes-license` for `futo-notes` served a checkout with no
    /// product in it, which is the bug this pins.
    #[test]
    fn buy_urls_name_the_storefront_product_and_carry_the_platform() {
        assert_eq!(
            buy_url(Environment::Staging.config(), Platform::Ios),
            "https://staging-pay2.futo.org/checkout/polar/futo-notes/futo-notes-license\
             /checkout-ready?platform=ios&success=redirect-to-organization-page"
        );
    }

    /// The activation payload's product field and the checkout URL's product
    /// segment are different strings for different jobs. Unifying them breaks
    /// one of the two: `PRODUCT_SLUG` is matched against bytes the server
    /// already signed, `CHECKOUT_PRODUCT_SLUG` is a path segment on the
    /// storefront.
    #[test]
    fn the_checkout_slug_is_not_the_activation_payloads_product() {
        assert_ne!(PRODUCT_SLUG, CHECKOUT_PRODUCT_SLUG);
        assert!(buy_url(Environment::Staging.config(), Platform::Desktop)
            .contains("/futo-notes/futo-notes-license/"));
    }

    #[test]
    fn a_dev_build_can_never_open_production_checkout() {
        let staging = buy_url(Environment::Staging.config(), Platform::Desktop);
        let production = buy_url(Environment::Production.config(), Platform::Desktop);
        assert!(staging.starts_with(STAGING_PAY2_BASE_URL), "{staging}");
        assert!(
            production.starts_with(PRODUCTION_PAY2_BASE_URL),
            "{production}"
        );
        assert!(!staging.contains("//pay2.futo.org"), "{staging}");
    }

    #[test]
    fn the_buy_url_asks_for_a_page_a_browser_can_render() {
        // `/price` and `/info` on the same path are JSON APIs for the in-app
        // sheets; handing either to the system browser would show a buyer a
        // blob of JSON instead of a checkout.
        let url = buy_url(Environment::Production.config(), Platform::Android);
        assert!(url.contains("/checkout-ready?"), "{url}");
        // `success` must be present or the deployed FUTOpay answers 422.
        assert!(url.contains("success="), "{url}");
    }

    /// The buyer pays in the system browser, so what FUTOpay serves at the end
    /// of the flow is a page a human reads. An empty `success` is the
    /// client-driven marker — FUTOpay answers it with the raw activation JSON,
    /// the contract of the in-app-WebView clients this app never runs — and a
    /// buyer who just paid stared at JSON (observed on staging 2026-09-11).
    /// The storefront's own marker instead lands them on the license key page,
    /// which shows the key as HTML and carries the Activate deep link.
    #[test]
    fn the_buy_url_returns_the_buyer_to_the_license_key_page() {
        let url = buy_url(Environment::Production.config(), Platform::Desktop);
        assert!(
            url.contains("success=redirect-to-organization-page"),
            "{url}"
        );
    }

    #[test]
    fn the_two_environments_never_share_a_key_or_a_host() {
        let production = Environment::Production.config();
        let staging = Environment::Staging.config();
        assert_ne!(production.public_key_base64, staging.public_key_base64);
        assert_ne!(production.pay2_base_url, staging.pay2_base_url);
    }

    #[test]
    fn a_trailing_slash_on_the_base_url_does_not_double_up() {
        let config = LicenseConfig {
            public_key_base64: "",
            pay2_base_url: "https://pay2.example.test/",
        };
        assert_eq!(
            activation_url(config, "FN-AB12"),
            "https://pay2.example.test/api/v1/activate/FN-AB12"
        );
    }

    #[test]
    fn path_separators_cannot_escape_the_activation_segment() {
        let config = LicenseConfig {
            public_key_base64: "",
            pay2_base_url: "https://pay2.example.test",
        };
        assert_eq!(
            activation_url(config, "a/../b c"),
            "https://pay2.example.test/api/v1/activate/a%2F..%2Fb%20c"
        );
    }
}
