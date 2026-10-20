//! What a build may say about buying, and the Buy and activation URLs.

use super::{LicenseConfig, Platform, CHECKOUT_PRODUCT_SLUG, ORG_SLUG};

/// Where a build is installed from. It decides what the License card may say
/// about buying (docs/spec/license.md § Store posture); the shell reports the
/// fact and this crate decides what it means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Distribution {
    Desktop,
    /// The App Store; the storefront country decides the surface.
    IosAppStore,
    /// GitLab releases, Obtainium, F-Droid: no store policy applies.
    AndroidDirect,
    /// Google Play.
    AndroidPlay,
}

/// What the License card and the app icon ask may do about buying.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PurchaseSurface {
    /// Buy / Renew open checkout in the browser.
    LinkOut,
    /// No Buy: the card names the website in plain, non-tappable text. Google
    /// Play's consumption-only rule allows saying where to buy without a link
    /// (Play Console Help 10281818, ADR-0005).
    NameWebsite,
    /// No Buy and no website: the key field and the deep link only.
    KeyOnly,
}

/// The one storefront rule. An unknown iOS storefront fails closed to
/// [`PurchaseSurface::KeyOnly`]. Android `play` names the website worldwide: the
/// consumption-only rule has no country exception, so it takes no country.
pub fn license_purchase_surface(
    distribution: Distribution,
    storefront_country: Option<&str>,
) -> PurchaseSurface {
    match distribution {
        Distribution::Desktop | Distribution::AndroidDirect => PurchaseSurface::LinkOut,
        Distribution::IosAppStore if storefront_country == Some("USA") => PurchaseSurface::LinkOut,
        Distribution::IosAppStore => PurchaseSurface::KeyOnly,
        Distribution::AndroidPlay => PurchaseSurface::NameWebsite,
    }
}

/// Whether checkout may be linked: [`license_purchase_surface`] said as a yes
/// or no, for the iOS shell, which still asks this way. `build_allows` false
/// turns iOS off and is how an Android caller says `play`.
pub fn license_link_out(
    platform: Platform,
    storefront_country: Option<&str>,
    build_allows: bool,
) -> bool {
    let distribution = match platform {
        Platform::Desktop => Distribution::Desktop,
        Platform::Ios if !build_allows => return false,
        Platform::Ios => Distribution::IosAppStore,
        Platform::Android if build_allows => Distribution::AndroidDirect,
        Platform::Android => Distribution::AndroidPlay,
    };
    license_purchase_surface(distribution, storefront_country) == PurchaseSurface::LinkOut
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
/// `from` is attribution only too: which surface the buyer tapped Buy on. It
/// rides the click the user already makes; nothing is requested or stored
/// before it. Every caller names its [`BuySource`]; there is no default.
pub fn buy_url(config: LicenseConfig<'_>, platform: Platform, source: BuySource) -> String {
    format!(
        "{}/checkout/polar/{ORG_SLUG}/{CHECKOUT_PRODUCT_SLUG}/checkout-ready?platform={}&from={}&success=redirect-to-organization-page",
        config.pay2_base_url.trim_end_matches('/'),
        platform.slug(),
        source.slug()
    )
}

/// Which surface sent the buyer to checkout (the Buy URL's `from`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuySource {
    /// The License card's Buy / Renew button.
    LicenseCard,
    /// The app icon picker's "included with a license" sheet.
    AppIconPicker,
}

impl BuySource {
    pub fn slug(self) -> &'static str {
        match self {
            BuySource::LicenseCard => "license-card",
            BuySource::AppIconPicker => "app-icon",
        }
    }
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
