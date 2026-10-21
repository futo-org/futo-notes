//! The license state and the diagnostic reasons behind an Invalid one.

use time::OffsetDateTime;

use crate::activation::{verify_activation, VerifiedActivation};
use crate::config::{LicenseConfig, PRODUCT_SLUG};
use crate::input::LicensePair;
use crate::key::{is_valid_license_key, normalize_license_key};

/// What a stored pair claims, once verified.
///
/// Three of the four fields are optional because a **v1** activation carries
/// only a signature over the license key: it names no product, no purchase
/// time and no expiry. `None` here means "the activation did not say", and the
/// shells render that by dropping the clause — never by substituting a default,
/// today's date, or the moment the activation was fetched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LicenseDetails {
    /// The normalized license key.
    pub key: String,
    /// The FUTOpay product slug a v2 payload names — always [`PRODUCT_SLUG`],
    /// because any other value is Invalid. `None` for a v1 activation, whose
    /// product binding is the org key pair rather than the payload.
    pub product: Option<String>,
    /// Purchase time — the source of the card's "Licensed since {date}". `None`
    /// for a v1 activation, and the card then leaves that row blank rather than
    /// inventing a date (docs/spec/license.md § States and copy).
    pub issued_at: Option<OffsetDateTime>,
    /// `None` for a perpetual product, and always `None` for v1, which cannot
    /// express an expiry at all.
    pub expires_at: Option<OffsetDateTime>,
}

/// The answer to "is this device licensed, at this instant?".
///
/// How the shells' License card reads this:
///
/// | This crate says | Card state |
/// |---|---|
/// | nothing stored | **Unlicensed** |
/// | `Invalid(_)` for a stored pair | **Unlicensed** |
/// | `Licensed` | **Licensed** — "Licensed since {date}" and a "Perpetual" or "Valid until {date}" term, each row left blank when its field is `None` |
/// | `Expired` | **Expired** — an expired license is kept and still shows its "Licensed since" date |
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LicenseState {
    Licensed(LicenseDetails),
    Expired(LicenseDetails),
    Invalid(InvalidReason),
}

impl LicenseState {
    /// The card state this verdict renders as — the one mapping every shell
    /// uses. `Invalid` flattens to `Unlicensed`: the reason is diagnostic only.
    pub fn status(&self) -> LicenseStatus {
        match self {
            LicenseState::Licensed(_) => LicenseStatus::Licensed,
            LicenseState::Expired(_) => LicenseStatus::Expired,
            LicenseState::Invalid(_) => LicenseStatus::Unlicensed,
        }
    }
}

/// Why a pair was rejected.
///
/// **Diagnostic only.** No user ever sees this: every reason renders as the one
/// specified message ("This license key isn't valid"). It exists so the
/// conformance goldens can prove each vector fails for the reason it was
/// written to prove, instead of passing by accident.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidReason {
    /// Not any of the three accepted input shapes.
    UnrecognizedInput,
    /// The key is not eight groups of four from the FUTOpay alphabet.
    MalformedKey,
    /// Neither `v2.<payload>.<signature>` nor a bare v1 signature.
    MalformedActivation,
    /// A version tag this build does not implement (`v3.…`), or a bare `v1`
    /// tag with no activation after it. A real v1 activation has no envelope,
    /// so it never lands here.
    UnsupportedVersion,
    /// A segment is not base64url without padding.
    MalformedBase64,
    /// The signature does not verify against this build's org public key.
    SignatureMismatch,
    /// The signed bytes are not the JSON this contract defines.
    MalformedPayload,
    /// The activation was minted for a different license key.
    KeyMismatch,
    /// The activation was minted for a different FUTOpay product.
    WrongProduct,
    /// This build's baked-in public key could not be read at all — a packaging
    /// bug, not a user's bad paste. `constants_match_the_fixture` fails if a
    /// shipped constant can produce this.
    VerificationKeyUnusable,
}

/// The whole rule, offline: parse, verify, match the key, match the product,
/// compare the clock. Nothing else.
///
/// `now` is injected — the client trusts the device clock, and a user who sets
/// it back to keep a badge has spent effort to fool only themselves.
pub fn evaluate(
    pair: &LicensePair,
    config: LicenseConfig<'_>,
    now: OffsetDateTime,
) -> LicenseState {
    let key = normalize_license_key(&pair.key);
    if !is_valid_license_key(&key) {
        return LicenseState::Invalid(InvalidReason::MalformedKey);
    }
    let verified = match verify_activation(&pair.activation, &key, config.public_key_base64) {
        Ok(verified) => verified,
        Err(reason) => return LicenseState::Invalid(reason),
    };
    let payload = match verified {
        // v1 signs the license key itself, so a verified signature has already
        // proved the key matches — there is no payload to compare it against,
        // and nothing else to check. It is perpetual because the format cannot
        // say otherwise, not because a server told us so.
        VerifiedActivation::V1 => {
            return LicenseState::Licensed(LicenseDetails {
                key,
                product: None,
                issued_at: None,
                expires_at: None,
            })
        }
        VerifiedActivation::V2(payload) => payload,
    };
    if !normalize_license_key(&payload.key).eq(&key) {
        return LicenseState::Invalid(InvalidReason::KeyMismatch);
    }
    if payload.product != PRODUCT_SLUG {
        return LicenseState::Invalid(InvalidReason::WrongProduct);
    }
    let expired = payload.expires_at.is_some_and(|expires| now >= expires);
    let details = LicenseDetails {
        key,
        product: Some(payload.product),
        issued_at: Some(payload.issued_at),
        expires_at: payload.expires_at,
    };
    if expired {
        LicenseState::Expired(details)
    } else {
        LicenseState::Licensed(details)
    }
}

/// The three states a License card can be in. [`LicenseState::Invalid`] is not
/// one of them: a stored pair that stopped verifying reads as `Unlicensed`,
/// exactly like no license at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LicenseStatus {
    Unlicensed,
    Licensed,
    Expired,
}

/// What a license includes beyond the card. Cosmetic only, by policy
/// (docs/spec/license.md): a working feature never appears here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LicenseInclusion {
    /// Choosing any app icon beyond [`app_icons_every_install_has`] (native
    /// shells).
    AppIcon,
}

/// The app icons every install can choose, licensed or not, by their permanent
/// ids (docs/spec/settings/native-app-icons.md). [`LicenseInclusion::AppIcon`]
/// is choosing any of the others. Standard is also the default.
pub fn app_icons_every_install_has() -> Vec<&'static str> {
    vec!["light-standard", "light-reversed"]
}

/// The one place the inclusion policy lives. Licensed includes everything
/// listed; Unlicensed and Expired include nothing (Expired is Unlicensed with
/// a story). Shells ask; none of them keeps a copy of this table.
pub fn license_includes(status: LicenseStatus) -> Vec<LicenseInclusion> {
    match status {
        LicenseStatus::Licensed => vec![LicenseInclusion::AppIcon],
        LicenseStatus::Unlicensed | LicenseStatus::Expired => Vec::new(),
    }
}

/// The two facts a device can hold about having paid: its license key's
/// status, and (iOS only) whether this Apple Account owns the App Store
/// purchase (ADR-0009). The shell reports both; this crate decides what they
/// mean.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LicenseEvidence {
    pub key: LicenseStatus,
    /// StoreKit verified the App Store-only purchase on this device. Always
    /// false off iOS.
    pub app_store: bool,
}

/// Which License card a device shows. A Licensed key wins over an App Store
/// purchase: it carries more (a key, Remove, the other platforms).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LicensePlate {
    Unlicensed,
    Licensed,
    /// The App Store purchase is owned and no Licensed key is stored.
    AppStore,
    Expired,
}

pub fn license_plate(evidence: LicenseEvidence) -> LicensePlate {
    match (evidence.key, evidence.app_store) {
        (LicenseStatus::Licensed, _) => LicensePlate::Licensed,
        (_, true) => LicensePlate::AppStore,
        (LicenseStatus::Expired, false) => LicensePlate::Expired,
        (LicenseStatus::Unlicensed, false) => LicensePlate::Unlicensed,
    }
}

/// [`license_includes`] for everything a device holds. The App Store purchase
/// includes exactly what a Licensed key includes, by construction: App Review
/// 3.1.3(b) accepts a key only because the same items are sold in-app.
pub fn evidence_includes(evidence: LicenseEvidence) -> Vec<LicenseInclusion> {
    match license_plate(evidence) {
        LicensePlate::Licensed | LicensePlate::AppStore => {
            license_includes(LicenseStatus::Licensed)
        }
        LicensePlate::Unlicensed | LicensePlate::Expired => Vec::new(),
    }
}

#[cfg(test)]
mod includes_tests {
    use super::*;

    const STATUSES: [LicenseStatus; 3] = [
        LicenseStatus::Unlicensed,
        LicenseStatus::Licensed,
        LicenseStatus::Expired,
    ];

    /// Adding an inclusion is a policy change: it must be a deliberate edit here.
    #[test]
    fn only_licensed_includes_the_app_icon() {
        for (status, expected) in [
            (LicenseStatus::Licensed, vec![LicenseInclusion::AppIcon]),
            (LicenseStatus::Unlicensed, vec![]),
            (LicenseStatus::Expired, vec![]),
        ] {
            assert_eq!(license_includes(status), expected, "{status:?}");
        }
    }

    /// Which icons need no license is policy too: Standard and Reversed only.
    #[test]
    fn every_install_has_standard_and_reversed() {
        assert_eq!(
            app_icons_every_install_has(),
            ["light-standard", "light-reversed"]
        );
    }

    /// 3.1.3(b) parity: whatever a key includes, the App Store purchase
    /// includes too, whatever the key says.
    #[test]
    fn the_app_store_purchase_includes_what_a_licensed_key_includes() {
        for key in STATUSES {
            assert_eq!(
                evidence_includes(LicenseEvidence {
                    key,
                    app_store: true
                }),
                license_includes(LicenseStatus::Licensed),
                "{key:?}"
            );
            assert_eq!(
                evidence_includes(LicenseEvidence {
                    key,
                    app_store: false
                }),
                license_includes(key),
                "{key:?}"
            );
        }
    }

    #[test]
    fn a_licensed_key_wins_the_plate() {
        use LicensePlate::*;
        for (key, app_store, expected) in [
            (LicenseStatus::Licensed, true, Licensed),
            (LicenseStatus::Licensed, false, Licensed),
            (LicenseStatus::Expired, true, AppStore),
            (LicenseStatus::Unlicensed, true, AppStore),
            (LicenseStatus::Expired, false, Expired),
            (LicenseStatus::Unlicensed, false, Unlicensed),
        ] {
            assert_eq!(
                license_plate(LicenseEvidence { key, app_store }),
                expected,
                "{key:?} app_store={app_store}"
            );
        }
    }
}
