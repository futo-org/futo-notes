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
