//! The license evidence a storefront receipt adds, and what each status includes.

use super::*;

/// The two facts a device can hold about having paid
/// (`futo_notes_license::LicenseEvidence`). `app_store` is always false off iOS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct LicenseEvidence {
    pub key: LicenseStatus,
    pub app_store: bool,
}

impl From<LicenseEvidence> for CoreLicenseEvidence {
    fn from(evidence: LicenseEvidence) -> Self {
        Self {
            key: evidence.key.into(),
            app_store: evidence.app_store,
        }
    }
}

/// Which License card to show. A Licensed key wins over the App Store purchase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LicensePlate {
    Unlicensed,
    Licensed,
    /// The App Store purchase is owned and no Licensed key is stored.
    AppStore,
    Expired,
}

/// `futo_notes_license::license_plate`.
#[uniffi::export]
pub fn license_plate(evidence: LicenseEvidence) -> LicensePlate {
    match core_license_plate(evidence.into()) {
        CoreLicensePlate::Unlicensed => LicensePlate::Unlicensed,
        CoreLicensePlate::Licensed => LicensePlate::Licensed,
        CoreLicensePlate::AppStore => LicensePlate::AppStore,
        CoreLicensePlate::Expired => LicensePlate::Expired,
    }
}

/// What everything this device holds includes: a Licensed key, or the App
/// Store purchase, includes the same things (3.1.3(b) parity).
#[uniffi::export]
pub fn license_evidence_includes(evidence: LicenseEvidence) -> Vec<LicenseInclusion> {
    core_evidence_includes(evidence.into())
        .into_iter()
        .map(Into::into)
        .collect()
}

/// The App Store product the iOS shell loads, so Swift does not hardcode it.
#[uniffi::export]
pub fn license_app_store_product_id() -> String {
    APP_STORE_PRODUCT_ID.to_string()
}

/// [`license_surface_row_actions`] once the App Store purchase is in play.
///
/// `app_store_offered` is true only on an iOS build whose product loaded.
/// Link-out gives the website and the App Store equal weight, in that order;
/// key-only keeps the key field first and the App Store second (ADR-0009). The
/// App Store plate offers only the key field: a purchase cannot be removed
/// from an Apple Account, and a key bought later still has somewhere to go.
#[uniffi::export]
pub fn license_evidence_row_actions(
    evidence: LicenseEvidence,
    surface: LicensePurchaseSurface,
    app_store_offered: bool,
) -> Vec<LicenseAction> {
    use LicenseAction::*;
    let plate = license_plate(evidence);
    if plate == LicensePlate::AppStore {
        return vec![EnterKey];
    }
    let status = evidence.key;
    if !app_store_offered || plate == LicensePlate::Licensed {
        return license_surface_row_actions(status, surface);
    }
    let buy = if plate == LicensePlate::Expired {
        Renew
    } else {
        Buy
    };
    match surface {
        LicensePurchaseSurface::LinkOut => {
            vec![buy, BuyInAppStore, EnterKey, RestorePurchases, LostKey]
        }
        LicensePurchaseSurface::NameWebsite => {
            vec![EnterKey, BuyInAppStore, RestorePurchases, LostKey]
        }
        LicensePurchaseSurface::KeyOnly => vec![EnterKey, BuyInAppStore, RestorePurchases],
    }
}

/// What a license includes beyond the card. Cosmetic only, by policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LicenseInclusion {
    /// Choosing any app icon beyond `license_app_icons_every_install_has`.
    AppIcon,
}

impl From<CoreLicenseInclusion> for LicenseInclusion {
    fn from(inclusion: CoreLicenseInclusion) -> Self {
        match inclusion {
            CoreLicenseInclusion::AppIcon => LicenseInclusion::AppIcon,
        }
    }
}

/// The app icons every install can choose, licensed or not, by permanent id.
/// The rule is `futo_notes_license::app_icons_every_install_has`.
#[uniffi::export]
pub fn license_app_icons_every_install_has() -> Vec<String> {
    core_app_icons_every_install_has()
        .into_iter()
        .map(String::from)
        .collect()
}

/// What this status includes. The rule is `futo_notes_license::license_includes`;
/// shells derive their `includes` set from it whenever the view changes.
#[uniffi::export]
pub fn license_includes(status: LicenseStatus) -> Vec<LicenseInclusion> {
    core_license_includes(status.into())
        .into_iter()
        .map(Into::into)
        .collect()
}
