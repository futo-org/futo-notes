use aes_gcm::aead::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use super::cipher::{aes_gcm_decrypt, aes_gcm_encrypt, KEY_BYTES};
use super::password_key::{derive_password_key, generate_salt, PBKDF2_ITERATIONS};
use super::E2eeError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeyMaterial {
    pub key_salt: String,
    pub key_kdf: KeyKdf,
    pub encrypted_vault_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeyKdf {
    pub kdf: String,
    pub iterations: u32,
    pub hash: String,
}

impl KeyKdf {
    pub fn pbkdf2_sha256_default() -> Self {
        Self {
            kdf: "pbkdf2-sha256".to_owned(),
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256".to_owned(),
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
        },
    ))
}

pub fn unwrap_vault_key(
    password: &str,
    material: &KeyMaterial,
) -> Result<[u8; KEY_BYTES], E2eeError> {
    if material.key_kdf.kdf != "pbkdf2-sha256" || material.key_kdf.hash != "SHA-256" {
        return Err(E2eeError::UnsupportedKdf(material.key_kdf.kdf.clone()));
    }
    let salt = hex::decode(&material.key_salt)?;
    let encrypted = hex::decode(&material.encrypted_vault_key)?;
    let password_key = derive_password_key(password, &salt, material.key_kdf.iterations);
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

    #[test]
    fn wrap_unwrap_round_trip() {
        let (key, material) = wrap_vault_key("hunter2").unwrap();
        assert_eq!(material.key_kdf.kdf, "pbkdf2-sha256");
        assert_eq!(material.key_kdf.iterations, PBKDF2_ITERATIONS);
        assert_eq!(material.key_kdf.hash, "SHA-256");
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
