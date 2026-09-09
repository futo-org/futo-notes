//! The license state and the diagnostic reasons behind an Invalid one.

use time::OffsetDateTime;

use crate::activation::verify_activation;
use crate::config::{LicenseConfig, PRODUCT_SLUG};
use crate::input::LicensePair;
use crate::key::{is_valid_license_key, normalize_license_key};

/// What a stored pair claims, once verified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LicenseDetails {
    /// The normalized license key.
    pub key: String,
    /// The FUTOpay product slug. Always [`PRODUCT_SLUG`] for a valid license.
    pub product: String,
    /// Purchase time — the source of "Supporter since {year}".
    pub issued_at: OffsetDateTime,
    /// `None` for a perpetual product.
    pub expires_at: Option<OffsetDateTime>,
}

/// The answer to "is this device licensed, at this instant?".
///
/// How the shells' License row reads this:
///
/// | This crate says | Row state |
/// |---|---|
/// | nothing stored | **Unlicensed** |
/// | `Invalid(_)` for a stored pair | **Unlicensed** |
/// | `Licensed` | **Licensed** — "Supporter since {year} · Valid until {date}" |
/// | `Expired` | **Expired** — an expired license is kept and still says "Supporter since" |
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LicenseState {
    Licensed(LicenseDetails),
    Expired(LicenseDetails),
    Invalid(InvalidReason),
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
    /// Not `v2.<payload>.<signature>`.
    MalformedActivation,
    /// A v1 (Grayjay-era) activation, or a version this build does not know.
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
    let payload = match verify_activation(&pair.activation, config.public_key_base64) {
        Ok(payload) => payload,
        Err(reason) => return LicenseState::Invalid(reason),
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
        product: payload.product,
        issued_at: payload.issued_at,
        expires_at: payload.expires_at,
    };
    if expired {
        LicenseState::Expired(details)
    } else {
        LicenseState::Licensed(details)
    }
}
