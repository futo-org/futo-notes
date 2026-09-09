//! Parsing and verifying a v2 FUTOpay activation.
//!
//! `v2.<payload>.<signature>`, where `<payload>` is base64url (no padding) of
//! canonical JSON and `<signature>` is base64url (no padding) of an RSA-SHA256
//! PKCS#1 v1.5 signature over the exact payload bytes.
//!
//! The signature is checked **before** the payload is parsed, and the payload
//! bytes are never re-serialized: what the signature covers is what arrived, so
//! there is no canonical-JSON rule on the client to get wrong.

use base64::Engine as _;
use ring::signature;
use spki::der::Decode as _;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::state::InvalidReason;

/// rsaEncryption. Anything else in the SubjectPublicKeyInfo is not our key.
const RSA_ENCRYPTION_OID: spki::ObjectIdentifier =
    spki::ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.1");

/// The signed contents of an activation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActivationPayload {
    pub key: String,
    pub product: String,
    pub issued_at: OffsetDateTime,
    pub expires_at: Option<OffsetDateTime>,
}

/// Verify an activation against an org public key and return what it claims.
pub(crate) fn verify_activation(
    activation: &str,
    public_key_base64: &str,
) -> Result<ActivationPayload, InvalidReason> {
    let (payload_segment, signature_segment) = split_v2(activation)?;
    let payload_bytes = decode_base64url(payload_segment)?;
    let signature_bytes = decode_base64url(signature_segment)?;

    let public_key =
        rsa_public_key_der(public_key_base64).ok_or(InvalidReason::VerificationKeyUnusable)?;
    signature::UnparsedPublicKey::new(&signature::RSA_PKCS1_2048_8192_SHA256, &public_key)
        .verify(&payload_bytes, &signature_bytes)
        .map_err(|_| InvalidReason::SignatureMismatch)?;

    parse_payload(&payload_bytes)
}

/// Split `v2.<payload>.<signature>`.
///
/// A dot-free activation is the **v1** FUTOpay format — a bare base64url
/// signature over the key string, which Grayjay still issues and FUTO Notes
/// deliberately does not accept — so it is reported as an unsupported version
/// rather than as garbage.
fn split_v2(activation: &str) -> Result<(&str, &str), InvalidReason> {
    if activation.trim().is_empty() {
        return Err(InvalidReason::MalformedActivation);
    }
    let segments: Vec<&str> = activation.split('.').collect();
    match segments.as_slice() {
        ["v2", payload, signature] => Ok((payload, signature)),
        [only] if is_version_tag(only) => Err(InvalidReason::UnsupportedVersion),
        [version, _, _] if is_version_tag(version) => Err(InvalidReason::UnsupportedVersion),
        [_only] => Err(InvalidReason::UnsupportedVersion),
        _ => Err(InvalidReason::MalformedActivation),
    }
}

fn is_version_tag(segment: &str) -> bool {
    segment
        .strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
}

fn decode_base64url(segment: &str) -> Result<Vec<u8>, InvalidReason> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| InvalidReason::MalformedBase64)
}

/// Unwrap a SubjectPublicKeyInfo down to the PKCS#1 `RSAPublicKey` DER that
/// ring verifies with. Accepts PEM armor and whitespace, and either base64
/// alphabet, so the real key can be pasted in whatever shape lib-polar hands
/// it over in.
fn rsa_public_key_der(public_key_base64: &str) -> Option<Vec<u8>> {
    let body: String = public_key_base64
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .flat_map(|line| line.chars())
        .filter(|c| !c.is_whitespace())
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(&body)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&body))
        .ok()?;
    let info = spki::SubjectPublicKeyInfoRef::from_der(&der).ok()?;
    if info.algorithm.oid != RSA_ENCRYPTION_OID {
        return None;
    }
    Some(info.subject_public_key.as_bytes()?.to_vec())
}

fn parse_payload(bytes: &[u8]) -> Result<ActivationPayload, InvalidReason> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| InvalidReason::MalformedPayload)?;
    let object = value.as_object().ok_or(InvalidReason::MalformedPayload)?;

    let string = |field: &str| -> Result<String, InvalidReason> {
        object
            .get(field)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or(InvalidReason::MalformedPayload)
    };
    let timestamp = |raw: &str| -> Result<OffsetDateTime, InvalidReason> {
        OffsetDateTime::parse(raw, &Rfc3339).map_err(|_| InvalidReason::MalformedPayload)
    };

    // `expires_at` must be PRESENT. `null` is how a perpetual product says so;
    // an absent field is a payload we do not understand, and guessing
    // "perpetual" would turn a server bug into a free forever-license.
    let expires_at = match object.get("expires_at") {
        None => return Err(InvalidReason::MalformedPayload),
        Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(raw)) => Some(timestamp(raw)?),
        Some(_) => return Err(InvalidReason::MalformedPayload),
    };

    Ok(ActivationPayload {
        key: string("key")?,
        product: string("product")?,
        issued_at: timestamp(&string("issued_at")?)?,
        expires_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_baked_in_keys_unwrap_to_an_rsa_public_key() {
        for key in [
            crate::config::PRODUCTION_PUBLIC_KEY_BASE64,
            crate::config::STAGING_PUBLIC_KEY_BASE64,
        ] {
            assert!(rsa_public_key_der(key).is_some());
        }
    }

    #[test]
    fn pem_armor_and_line_breaks_are_accepted() {
        let raw = crate::config::STAGING_PUBLIC_KEY_BASE64;
        let armored = format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n{}\n-----END PUBLIC KEY-----\n",
            &raw[..64],
            &raw[64..]
        );
        assert_eq!(rsa_public_key_der(&armored), rsa_public_key_der(raw));
    }

    #[test]
    fn a_non_rsa_or_unreadable_key_is_refused_rather_than_trusted() {
        assert!(rsa_public_key_der("not a key").is_none());
        assert!(rsa_public_key_der("").is_none());
    }

    #[test]
    fn version_tags_are_told_apart_from_malformed_envelopes() {
        assert_eq!(split_v2("v1.a.b"), Err(InvalidReason::UnsupportedVersion));
        assert_eq!(split_v2("v10.a.b"), Err(InvalidReason::UnsupportedVersion));
        assert_eq!(
            split_v2("v2.a.b.c"),
            Err(InvalidReason::MalformedActivation)
        );
        assert_eq!(split_v2("v2.a"), Err(InvalidReason::MalformedActivation));
        assert_eq!(split_v2("v2.a.b"), Ok(("a", "b")));
    }
}
