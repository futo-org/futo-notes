use aes_gcm::aead::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use super::cipher::{aes_gcm_decrypt, aes_gcm_encrypt, KEY_BYTES};
use super::password_key::{
    derive_argon2id_key, derive_password_key, generate_salt, ARGON2ID_LANES, ARGON2ID_MEMORY_KIB,
    ARGON2ID_PASSES, PBKDF2_ITERATIONS,
};
use super::recovery_key::RecoveryKey;
use super::E2eeError;

const PBKDF2_SHA256: &str = "pbkdf2-sha256";
const ARGON2ID: &str = "argon2id";
const HKDF_SHA256: &str = "hkdf-sha256";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeyMaterial {
    pub key_salt: String,
    pub key_kdf: KeyKdf,
    pub encrypted_vault_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_updated_at: Option<String>,
    /// The recovery envelope: the same vault key wrapped under a recovery key
    /// instead of the vault password. All three fields are present together or
    /// not at all — a vault written by a v1 client has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_key_salt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_key_kdf: Option<RecoveryKdf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_encrypted_vault_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeyKdf {
    pub kdf: String,
    /// PBKDF2 iterations, or Argon2id passes.
    pub iterations: u32,
    /// The PBKDF2 hash. Argon2id has no hash to choose, so it omits this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_kib: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parallelism: Option<u32>,
}

impl KeyKdf {
    pub fn pbkdf2_sha256_default() -> Self {
        Self {
            kdf: PBKDF2_SHA256.to_owned(),
            iterations: PBKDF2_ITERATIONS,
            hash: Some("SHA-256".to_owned()),
            memory_kib: None,
            parallelism: None,
        }
    }

    pub fn argon2id_default() -> Self {
        Self {
            kdf: ARGON2ID.to_owned(),
            iterations: ARGON2ID_PASSES,
            hash: None,
            memory_kib: Some(ARGON2ID_MEMORY_KIB),
            parallelism: Some(ARGON2ID_LANES),
        }
    }
}

/// The recovery envelope's KDF descriptor. HKDF needs no parameters beyond its
/// name, because the recovery key is already 128 uniformly random bits.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecoveryKdf {
    pub kdf: String,
}

impl RecoveryKdf {
    pub fn hkdf_sha256_default() -> Self {
        Self {
            kdf: HKDF_SHA256.to_owned(),
        }
    }
}

pub fn generate_vault_key() -> [u8; KEY_BYTES] {
    let mut out = [0u8; KEY_BYTES];
    OsRng.fill_bytes(&mut out);
    out
}

pub fn wrap_vault_key(password: &str) -> Result<([u8; KEY_BYTES], KeyMaterial), E2eeError> {
    let vault_key = generate_vault_key();
    let salt = generate_salt();
    let password_key = derive_password_key(password, &salt, PBKDF2_ITERATIONS);
    let encrypted = aes_gcm_encrypt(&password_key, &vault_key)?;
    Ok((
        vault_key,
        KeyMaterial {
            key_salt: hex::encode(salt),
            key_kdf: KeyKdf::pbkdf2_sha256_default(),
            encrypted_vault_key: hex::encode(encrypted),
            key_updated_at: None,
            recovery_key_salt: None,
            recovery_key_kdf: None,
            recovery_encrypted_vault_key: None,
        },
    ))
}

/// Wrap an existing vault key under a vault password with Argon2id — the
/// hosted envelope (ADR 0003). The key is an argument rather than generated
/// here because changing the vault password re-wraps the same key, and the
/// recovery envelope has to wrap that same key too.
pub fn wrap_vault_key_argon2id(
    vault_key: &[u8; KEY_BYTES],
    password: &str,
) -> Result<KeyMaterial, E2eeError> {
    let salt = generate_salt();
    let password_key = derive_argon2id_key(
        password,
        &salt,
        ARGON2ID_MEMORY_KIB,
        ARGON2ID_PASSES,
        ARGON2ID_LANES,
    )?;
    let encrypted = aes_gcm_encrypt(&password_key, vault_key)?;
    Ok(KeyMaterial {
        key_salt: hex::encode(salt),
        key_kdf: KeyKdf::argon2id_default(),
        encrypted_vault_key: hex::encode(encrypted),
        key_updated_at: None,
        recovery_key_salt: None,
        recovery_key_kdf: None,
        recovery_encrypted_vault_key: None,
    })
}

impl KeyMaterial {
    /// Add (or replace) the recovery envelope, wrapping the same vault key
    /// under a recovery key.
    pub fn set_recovery_envelope(
        &mut self,
        vault_key: &[u8; KEY_BYTES],
        recovery_key: &RecoveryKey,
    ) -> Result<(), E2eeError> {
        let salt = generate_salt();
        let wrap_key = recovery_key.derive_wrap_key(&salt);
        let encrypted = aes_gcm_encrypt(&wrap_key, vault_key)?;
        self.recovery_key_salt = Some(hex::encode(salt));
        self.recovery_key_kdf = Some(RecoveryKdf::hkdf_sha256_default());
        self.recovery_encrypted_vault_key = Some(hex::encode(encrypted));
        Ok(())
    }
}

/// Unwrap the vault key from the recovery envelope.
pub fn unwrap_vault_key_with_recovery_key(
    recovery_key: &RecoveryKey,
    material: &KeyMaterial,
) -> Result<[u8; KEY_BYTES], E2eeError> {
    let (Some(salt), Some(kdf), Some(encrypted)) = (
        material.recovery_key_salt.as_deref(),
        material.recovery_key_kdf.as_ref(),
        material.recovery_encrypted_vault_key.as_deref(),
    ) else {
        return Err(E2eeError::NoRecoveryEnvelope);
    };
    if kdf.kdf != HKDF_SHA256 {
        return Err(E2eeError::UnsupportedKdf(kdf.kdf.clone()));
    }
    let wrap_key = recovery_key.derive_wrap_key(&hex::decode(salt)?);
    let raw = aes_gcm_decrypt(&wrap_key, &hex::decode(encrypted)?)
        .map_err(|_| E2eeError::BadRecoveryKey)?;
    if raw.len() != KEY_BYTES {
        return Err(E2eeError::BadRecoveryKey);
    }
    let mut vault_key = [0u8; KEY_BYTES];
    vault_key.copy_from_slice(&raw);
    Ok(vault_key)
}

pub fn unwrap_vault_key(
    password: &str,
    material: &KeyMaterial,
) -> Result<[u8; KEY_BYTES], E2eeError> {
    let kdf = &material.key_kdf;
    let salt = hex::decode(&material.key_salt)?;
    let encrypted = hex::decode(&material.encrypted_vault_key)?;
    let password_key = match kdf.kdf.as_str() {
        PBKDF2_SHA256 if kdf.hash.as_deref() == Some("SHA-256") => {
            derive_password_key(password, &salt, kdf.iterations)
        }
        ARGON2ID => derive_argon2id_key(
            password,
            &salt,
            kdf.memory_kib.unwrap_or(ARGON2ID_MEMORY_KIB),
            kdf.iterations,
            kdf.parallelism.unwrap_or(ARGON2ID_LANES),
        )?,
        _ => return Err(E2eeError::UnsupportedKdf(kdf.kdf.clone())),
    };
    let raw = aes_gcm_decrypt(&password_key, &encrypted).map_err(|_| E2eeError::BadPassword)?;
    if raw.len() != KEY_BYTES {
        return Err(E2eeError::BadPassword);
    }
    let mut vault_key = [0u8; KEY_BYTES];
    vault_key.copy_from_slice(&raw);
    Ok(vault_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::e2ee::SALT_BYTES;
    use crate::e2ee::{aes_gcm_decrypt, aes_gcm_encrypt, pack_note_v2, unpack_note};
    use crate::e2ee::{ARGON2ID_LANES, ARGON2ID_MEMORY_KIB, ARGON2ID_PASSES};

    #[test]
    fn wrap_unwrap_round_trip() {
        let (key, material) = wrap_vault_key("hunter2").unwrap();
        assert_eq!(material.key_kdf.kdf, "pbkdf2-sha256");
        assert_eq!(material.key_kdf.iterations, PBKDF2_ITERATIONS);
        assert_eq!(material.key_kdf.hash.as_deref(), Some("SHA-256"));
        assert_eq!(material.key_salt.len(), SALT_BYTES * 2);
        let recovered = unwrap_vault_key("hunter2", &material).unwrap();
        assert_eq!(recovered, key);
    }

    #[test]
    fn unwrap_rejects_wrong_password() {
        let (_, material) = wrap_vault_key("right").unwrap();
        let error = unwrap_vault_key("wrong", &material).unwrap_err();
        assert!(matches!(error, E2eeError::BadPassword));
    }

    #[test]
    fn unwrap_rejects_unsupported_kdf() {
        let (_, mut material) = wrap_vault_key("p").unwrap();
        material.key_kdf.kdf = "scrypt".to_owned();
        let error = unwrap_vault_key("p", &material).unwrap_err();
        assert!(matches!(error, E2eeError::UnsupportedKdf(_)));
    }

    #[test]
    fn key_material_serde_round_trip() {
        let (_, material) = wrap_vault_key("p").unwrap();
        let json = serde_json::to_string(&material).unwrap();
        let round_trip: KeyMaterial = serde_json::from_str(&json).unwrap();
        assert_eq!(material, round_trip);
        assert!(json.contains("\"key_salt\""));
        assert!(json.contains("\"key_kdf\""));
        assert!(json.contains("\"encrypted_vault_key\""));
        assert!(!json.contains("\"key_updated_at\""));
    }

    #[test]
    fn key_material_serde_accepts_updated_at_from_server() {
        let raw = r#"{
            "key_salt": "00",
            "key_kdf": { "kdf": "pbkdf2-sha256", "iterations": 100000, "hash": "SHA-256" },
            "encrypted_vault_key": "00",
            "key_updated_at": "2026-05-13T00:00:00.000Z"
        }"#;
        let parsed: KeyMaterial = serde_json::from_str(raw).unwrap();
        assert_eq!(
            parsed.key_updated_at.as_deref(),
            Some("2026-05-13T00:00:00.000Z"),
        );
    }

    #[test]
    fn argon2id_wrap_unwrap_round_trip() {
        let vault_key = generate_vault_key();
        let material = wrap_vault_key_argon2id(&vault_key, "a long enough password").unwrap();
        assert_eq!(material.key_kdf.kdf, "argon2id");
        assert_eq!(material.key_kdf.iterations, ARGON2ID_PASSES);
        assert_eq!(material.key_kdf.memory_kib, Some(ARGON2ID_MEMORY_KIB));
        assert_eq!(material.key_kdf.parallelism, Some(ARGON2ID_LANES));
        assert_eq!(material.key_kdf.hash, None);
        assert_eq!(material.key_salt.len(), SALT_BYTES * 2);
        assert_eq!(
            unwrap_vault_key("a long enough password", &material).unwrap(),
            vault_key,
        );
    }

    #[test]
    fn argon2id_defaults_are_64_mib_three_passes_one_lane() {
        let kdf = KeyKdf::argon2id_default();
        assert_eq!(kdf.kdf, "argon2id");
        assert_eq!(kdf.memory_kib, Some(64 * 1024));
        assert_eq!(kdf.iterations, 3);
        assert_eq!(kdf.parallelism, Some(1));
    }

    #[test]
    fn argon2id_unwrap_rejects_wrong_password() {
        let vault_key = generate_vault_key();
        let material = wrap_vault_key_argon2id(&vault_key, "right password").unwrap();
        assert!(matches!(
            unwrap_vault_key("wrong password", &material),
            Err(E2eeError::BadPassword),
        ));
    }

    #[test]
    fn unwrap_still_rejects_an_unknown_kdf() {
        let vault_key = generate_vault_key();
        let mut material = wrap_vault_key_argon2id(&vault_key, "password okay").unwrap();
        material.key_kdf.kdf = "scrypt".to_owned();
        assert!(matches!(
            unwrap_vault_key("password okay", &material),
            Err(E2eeError::UnsupportedKdf(_)),
        ));
    }

    #[test]
    fn unwraps_a_pinned_v1_pbkdf2_envelope() {
        // Written by hand from an independent PBKDF2-HMAC-SHA256 + AES-256-GCM
        // implementation (Python `hashlib` + `cryptography`), NOT by this crate,
        // so a later refactor cannot silently drop v1 compatibility.
        let material = KeyMaterial {
            key_salt: "000102030405060708090a0b0c0d0e0f".to_owned(),
            key_kdf: KeyKdf {
                kdf: "pbkdf2-sha256".to_owned(),
                iterations: 100_000,
                hash: Some("SHA-256".to_owned()),
                memory_kib: None,
                parallelism: None,
            },
            encrypted_vault_key: concat!(
                "111111111111111111111111",
                "f056a52a90ab8bce7f7f5236a46dfed80328aee689288a576d7de71a97e9b7d6",
                "f087115d4a51fcbbec3e92833608d6ec",
            )
            .to_owned(),
            key_updated_at: None,
            recovery_key_salt: None,
            recovery_key_kdf: None,
            recovery_encrypted_vault_key: None,
        };
        assert_eq!(
            unwrap_vault_key("v1 vault password", &material).unwrap(),
            [0xA5u8; KEY_BYTES],
        );
    }

    #[test]
    fn a_v1_envelope_json_without_recovery_fields_still_parses() {
        let raw = r#"{
            "key_salt": "000102030405060708090a0b0c0d0e0f",
            "key_kdf": { "kdf": "pbkdf2-sha256", "iterations": 100000, "hash": "SHA-256" },
            "encrypted_vault_key": "00"
        }"#;
        let parsed: KeyMaterial = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.key_kdf.hash.as_deref(), Some("SHA-256"));
        assert!(parsed.recovery_key_salt.is_none());
        assert!(parsed.recovery_key_kdf.is_none());
        assert!(parsed.recovery_encrypted_vault_key.is_none());
    }

    #[test]
    fn explicit_null_recovery_fields_from_the_server_parse_as_absent() {
        let raw = r#"{
            "key_salt": "00",
            "key_kdf": { "kdf": "argon2id", "iterations": 3, "memory_kib": 65536, "parallelism": 1 },
            "encrypted_vault_key": "00",
            "recovery_key_salt": null,
            "recovery_key_kdf": null,
            "recovery_encrypted_vault_key": null
        }"#;
        let parsed: KeyMaterial = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.key_kdf.hash, None);
        assert!(parsed.recovery_key_salt.is_none());
    }

    #[test]
    fn recovery_envelope_round_trip() {
        let vault_key = generate_vault_key();
        let mut material = wrap_vault_key_argon2id(&vault_key, "the vault password").unwrap();
        assert!(material.recovery_key_salt.is_none());

        let recovery_key = RecoveryKey::generate();
        material
            .set_recovery_envelope(&vault_key, &recovery_key)
            .unwrap();

        assert_eq!(
            material
                .recovery_key_kdf
                .as_ref()
                .map(|kdf| kdf.kdf.as_str()),
            Some("hkdf-sha256"),
        );
        assert_eq!(
            material.recovery_key_salt.as_deref().map(str::len),
            Some(SALT_BYTES * 2),
        );
        assert_eq!(
            unwrap_vault_key_with_recovery_key(&recovery_key, &material).unwrap(),
            vault_key,
        );
        // Both envelopes open the same vault key.
        assert_eq!(
            unwrap_vault_key("the vault password", &material).unwrap(),
            vault_key,
        );
    }

    #[test]
    fn recovery_unwrap_rejects_the_wrong_recovery_key() {
        let vault_key = generate_vault_key();
        let mut material = wrap_vault_key_argon2id(&vault_key, "the vault password").unwrap();
        material
            .set_recovery_envelope(&vault_key, &RecoveryKey::generate())
            .unwrap();
        assert!(matches!(
            unwrap_vault_key_with_recovery_key(&RecoveryKey::generate(), &material),
            Err(E2eeError::BadRecoveryKey),
        ));
    }

    #[test]
    fn recovery_unwrap_reports_a_vault_with_no_recovery_envelope() {
        let (_, material) = wrap_vault_key("password").unwrap();
        assert!(matches!(
            unwrap_vault_key_with_recovery_key(&RecoveryKey::generate(), &material),
            Err(E2eeError::NoRecoveryEnvelope),
        ));
    }

    #[test]
    fn recovery_unwrap_rejects_an_unknown_recovery_kdf() {
        let vault_key = generate_vault_key();
        let mut material = wrap_vault_key_argon2id(&vault_key, "the vault password").unwrap();
        let recovery_key = RecoveryKey::generate();
        material
            .set_recovery_envelope(&vault_key, &recovery_key)
            .unwrap();
        material.recovery_key_kdf = Some(RecoveryKdf {
            kdf: "hkdf-sha512".to_owned(),
        });
        assert!(matches!(
            unwrap_vault_key_with_recovery_key(&recovery_key, &material),
            Err(E2eeError::UnsupportedKdf(_)),
        ));
    }

    #[test]
    fn key_material_with_both_envelopes_serializes_to_the_server_field_names() {
        let vault_key = generate_vault_key();
        let mut material = wrap_vault_key_argon2id(&vault_key, "the vault password").unwrap();
        material
            .set_recovery_envelope(&vault_key, &RecoveryKey::generate())
            .unwrap();
        let json = serde_json::to_string(&material).unwrap();
        for field in [
            "\"key_salt\"",
            "\"key_kdf\"",
            "\"encrypted_vault_key\"",
            "\"recovery_key_salt\"",
            "\"recovery_key_kdf\"",
            "\"recovery_encrypted_vault_key\"",
        ] {
            assert!(json.contains(field), "{field} missing from {json}");
        }
        assert_eq!(
            serde_json::from_str::<KeyMaterial>(&json).unwrap(),
            material
        );
    }

    #[test]
    fn full_pipeline_round_trip() {
        let password = "correct horse battery staple";
        let (vault_key, material) = wrap_vault_key(password).unwrap();

        let frame = pack_note_v2("Inbox/today.md", "remember the milk");
        let ciphertext = aes_gcm_encrypt(&vault_key, &frame).unwrap();

        let recovered_key = unwrap_vault_key(password, &material).unwrap();
        let plaintext = aes_gcm_decrypt(&recovered_key, &ciphertext).unwrap();
        let note = unpack_note(&plaintext).unwrap();
        assert_eq!(note.path, "Inbox/today.md");
        assert_eq!(note.content, "remember the milk");
    }
}
