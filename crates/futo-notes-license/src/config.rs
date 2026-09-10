//! Baked-in constants and the dev/prod split that selects between them.

/// The FUTOpay product slug for this app. A license minted for any other
/// product — a Grayjay license, say — is Invalid here.
pub const PRODUCT_SLUG: &str = "futo-notes";

/// The URL scheme all three shells register.
pub const DEEP_LINK_SCHEME: &str = "futonotes";

/// The only deep-link host this app defines. Anything else is ignored silently.
pub const DEEP_LINK_HOST: &str = "license";

/// The FUTOpay license-key alphabet: no I, L, O, or 0, so a key can be read
/// aloud and typed back.
pub const KEY_ALPHABET: &str = "ABCDEFGHJKMNPQRSTUVWXYZ123456789";

/// The FUTOpay organization that sells this product. Distinct from
/// [`PRODUCT_SLUG`] even though the two read the same today — one is the Polar
/// org, the other the product inside it, and the checkout path names both.
pub const ORG_SLUG: &str = "futo-notes";

/// Where "Lost your key?" goes. There is no in-app restore flow.
pub const SUPPORT_MAILTO: &str = "mailto:support@futo.tech";

/// What a dev build's bundle/package id ends with (`com.futo.notes.dev`).
pub const DEV_BUNDLE_ID_SUFFIX: &str = ".dev";

const PRODUCTION_PAY2_BASE_URL: &str = "https://pay2.futo.org";
const STAGING_PAY2_BASE_URL: &str = "https://staging-pay2.futo.org";

/// PLACEHOLDER — **not** the real FUTO Notes production key.
///
/// The production and staging key pairs are created in the lib-polar repo by
/// issue #155; until that lands this is a throwaway 2048-bit RSA public key
/// generated 2026-09-09 whose private half was never written down, so a release
/// build fails closed: nothing verifies, every user is Unlicensed, and no
/// license can be minted for it by anyone. Dropping the real key in is a
/// one-line change to this constant.
pub const PRODUCTION_PUBLIC_KEY_BASE64: &str = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3tL0DeuTWvGfzvamMzbJf6BbdjhiWMh8Dvi7ufKpSP8RRnhgRbNWUsrCCBdnF2mQk1Yw9vtUH4OemiU+Gik2io0KKK+4aj0qiP5h9cdEpCVDzFQPeagBftAu7RM7LF1/M+I5BjnugdOoi91R7l8HFmIIoYNTqPEV09VGBayEoTuMfmQJtcZumn8fmzZUtwJFdMzvubuCBIsSeq2U5s+Dz+umZHNhZ+0174P0KBjTCmOEZyyz88BTFysTeXOY/ZTgA4GtLGSntbCeEhtD7bRBrGL8n0UH8eISjlK/lEDvIzWRDRNyiIvfjTvnMtyj2A9ngJGP+dyRB8AS4DetI46eqQIDAQAB";

/// PLACEHOLDER — the **conformance fixture's** public key, not the real staging
/// key (issue #155 creates that too).
///
/// It is deliberately the fixture pair rather than a second throwaway: the spec
/// anticipates exactly this ("the fixture pair is the staging pair or the tests
/// point the dev build at it", docs/spec/license.md § The license), and it lets
/// #153-#155 drive a real License row on a dev build with a fixture license
/// before any server exists. The fixture private key is committed, so a staging
/// license is trivially mintable — which is fine for `.dev` builds and is the
/// reason this must never be the production constant.
pub const STAGING_PUBLIC_KEY_BASE64: &str = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5ZARcpH7Gj6Lr3kDHIJF6ddjYhgVMsWD6n2/YvPMMbcdTrhWTUBMLHd0OrjuppvAJJ85p6MieIv/YsEjdiqjb/f1JNzelXzcmMIy502SSbV8uxnSoZ8xKa4Vv46+AR+iLV3jgYmFMbFJ16oIZKnLHihLLujLtmuGaYJPccIGDxzyGdQ+gPY9wMuROOPd24RkfVfkGpG6XRgod901AdJiYyae7lpM+UjIweOyfGRny9cbwC4xUDGDSF+G//rUGiWJ4gjeQOvjw+uMWVc3Rdd+NLw4/hnBecbLaTziWl4aLE6gL+ZUPF3Bom+PZczy3cFUnJhTJaIlSNf8ysZI+Tt0EwIDAQAB";

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
    /// The environment a build's bundle/package id puts it in.
    ///
    /// The `.dev` suffix IS the dev/prod split on all three platforms (M3), so
    /// this is the one selector every shell can use. It deliberately replaced a
    /// `cfg!(debug_assertions)` version: the native shells build the FFI with
    /// `release-ffi` for their dev apps too, so a compile-profile test would
    /// have quietly put a `.dev` phone build on the production key.
    ///
    /// An id this crate does not recognise is Production — the fail-safe
    /// direction, since the production key cannot verify a staging license.
    pub fn for_bundle_id(bundle_id: &str) -> Self {
        if bundle_id.trim().ends_with(DEV_BUNDLE_ID_SUFFIX) {
            Environment::Staging
        } else {
            Environment::Production
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

/// The Buy / Renew destination: this environment's **generated checkout**,
/// opened in the **system browser** and never in an in-app WebView.
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
/// `success` is sent, empty. It is the buyer's return URL, and an
/// app-initiated purchase has none to hand back; the deployed FUTOpay requires
/// the parameter to be present (it 422s without it) while the newer branch
/// defaults it to exactly this empty value, so sending it empty is correct
/// against both. `platform` is attribution only and never changes price,
/// product, or entitlement.
pub fn buy_url(config: LicenseConfig<'_>, platform: Platform) -> String {
    format!(
        "{}/checkout/polar/{ORG_SLUG}/{PRODUCT_SLUG}/checkout-ready?platform={}&success=",
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
    fn a_dev_bundle_id_never_lands_on_the_production_key() {
        assert_eq!(
            Environment::for_bundle_id("com.futo.notes.dev"),
            Environment::Staging
        );
        assert_eq!(
            Environment::for_bundle_id("com.futo.notes"),
            Environment::Production
        );
        // Not a suffix match on the word, and not fooled by stray whitespace.
        assert_eq!(
            Environment::for_bundle_id("com.futo.notes.development"),
            Environment::Production
        );
        assert_eq!(
            Environment::for_bundle_id(" com.futo.notes.dev "),
            Environment::Staging
        );
    }

    #[test]
    fn buy_urls_carry_the_platform() {
        assert_eq!(
            buy_url(Environment::Staging.config(), Platform::Ios),
            "https://staging-pay2.futo.org/checkout/polar/futo-notes/futo-notes\
             /checkout-ready?platform=ios&success="
        );
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
