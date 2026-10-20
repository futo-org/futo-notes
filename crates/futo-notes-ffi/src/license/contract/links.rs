//! Where a license holder is sent: the storefront, checkout, and the row's actions.

use super::*;

/// Attribution only: which client sent the buyer to checkout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LicensePlatform {
    Ios,
    Android,
    Desktop,
}

/// Whether this distribution may offer a purchase link in this storefront.
/// An unknown iOS storefront is deliberately treated as outside the US.
#[uniffi::export]
pub fn license_link_out(
    platform: LicensePlatform,
    storefront_country: Option<String>,
    build_allows: bool,
) -> bool {
    futo_notes_license::license_link_out(
        platform.into(),
        storefront_country.as_deref(),
        build_allows,
    )
}

/// Where this build is installed from. The shell reports it; Rust decides what
/// it means for buying ([`license_purchase_surface`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LicenseDistribution {
    Desktop,
    IosAppStore,
    AndroidDirect,
    AndroidPlay,
}

/// What the License card and the app icon ask may do about buying.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LicensePurchaseSurface {
    /// Buy / Renew open checkout in the browser.
    LinkOut,
    /// No Buy: name [`LicenseLinks::website`] in plain, non-tappable text.
    NameWebsite,
    /// The key field and the deep link only.
    KeyOnly,
}

/// The storefront rule (`futo_notes_license::license_purchase_surface`).
/// An unknown iOS storefront fails closed to key-only.
#[uniffi::export]
pub fn license_purchase_surface(
    distribution: LicenseDistribution,
    storefront_country: Option<String>,
) -> LicensePurchaseSurface {
    let distribution = match distribution {
        LicenseDistribution::Desktop => Distribution::Desktop,
        LicenseDistribution::IosAppStore => Distribution::IosAppStore,
        LicenseDistribution::AndroidDirect => Distribution::AndroidDirect,
        LicenseDistribution::AndroidPlay => Distribution::AndroidPlay,
    };
    match core_license_purchase_surface(distribution, storefront_country.as_deref()) {
        PurchaseSurface::LinkOut => LicensePurchaseSurface::LinkOut,
        PurchaseSurface::NameWebsite => LicensePurchaseSurface::NameWebsite,
        PurchaseSurface::KeyOnly => LicensePurchaseSurface::KeyOnly,
    }
}

impl From<LicensePlatform> for Platform {
    fn from(platform: LicensePlatform) -> Self {
        match platform {
            LicensePlatform::Ios => Platform::Ios,
            LicensePlatform::Android => Platform::Android,
            LicensePlatform::Desktop => Platform::Desktop,
        }
    }
}

/// The Buy / Renew and "Lost your key?" destinations, read from the crate so
/// no shell hardcodes a URL and every platform agrees. Shells choose the
/// browser surface permitted by their distribution.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LicenseLinks {
    pub buy: String,
    pub support: String,
    /// The storefront as a person types it (`pay.futo.org`), for
    /// [`LicensePurchaseSurface::NameWebsite`]. Plain text only: never a link.
    pub website: String,
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
    /// Starts the App Store-only purchase (iOS, ADR-0009). Never offered off iOS.
    BuyInAppStore,
    /// Restores the App Store purchase for this Apple Account (App Review 3.1.1).
    RestorePurchases,
}

/// Which controls the row offers, in the order it offers them.
///
/// This is the spec's States-and-copy table (docs/spec/license.md), owned once
/// so the native shells cannot drift apart on it. Only
/// [`LicensePurchaseSurface::LinkOut`] offers Buy / Renew; naming the website
/// keeps "Lost your key?" (help that leads to no payment); key-only keeps the
/// key field alone (and the deep link, which is not a control).
#[uniffi::export]
pub fn license_surface_row_actions(
    status: LicenseStatus,
    surface: LicensePurchaseSurface,
) -> Vec<LicenseAction> {
    use LicensePurchaseSurface::*;
    match (status, surface) {
        // Remove is not a way out of the app, so every surface keeps it: a
        // licensed user can always hand the device on.
        (LicenseStatus::Licensed, _) => vec![LicenseAction::Remove],
        (LicenseStatus::Unlicensed, LinkOut) => vec![
            LicenseAction::Buy,
            LicenseAction::EnterKey,
            LicenseAction::LostKey,
        ],
        (LicenseStatus::Expired, LinkOut) => vec![
            LicenseAction::Renew,
            LicenseAction::EnterKey,
            LicenseAction::LostKey,
        ],
        (_, NameWebsite) => vec![LicenseAction::EnterKey, LicenseAction::LostKey],
        (_, KeyOnly) => vec![LicenseAction::EnterKey],
    }
}

/// [`license_surface_row_actions`] for a shell that still asks
/// [`license_link_out`] (iOS): `true` is link-out, `false` key-only.
#[uniffi::export]
pub fn license_row_actions(status: LicenseStatus, link_out: bool) -> Vec<LicenseAction> {
    let surface = if link_out {
        LicensePurchaseSurface::LinkOut
    } else {
        LicensePurchaseSurface::KeyOnly
    };
    license_surface_row_actions(status, surface)
}

/// Attribution only: which surface sent the buyer to checkout (`from=`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum BuySource {
    LicenseCard,
    AppIconPicker,
}

impl From<BuySource> for CoreBuySource {
    fn from(source: BuySource) -> Self {
        match source {
            BuySource::LicenseCard => CoreBuySource::LicenseCard,
            BuySource::AppIconPicker => CoreBuySource::AppIconPicker,
        }
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
pub fn license_links(
    platform: LicensePlatform,
    bundle_id: String,
    source: BuySource,
) -> LicenseLinks {
    let environment = Environment::for_bundle_id(&bundle_id);
    LicenseLinks {
        buy: buy_url(environment.config(), platform.into(), source.into()),
        support: SUPPORT_MAILTO.to_string(),
        website: environment.website_address().to_string(),
    }
}
