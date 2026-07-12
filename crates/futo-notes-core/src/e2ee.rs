//! End-to-end-encrypted sync primitives.
//!
//! Pure-Rust port of the client-side E2EE crypto (originally
//! `src/lib/e2eeCrypto.ts`, since deleted as dead code — runtime crypto is
//! Rust-only) so the Rust sync orchestrator emits + decodes the exact same
//! wire format as older TS-built clients.
//!
//! Wire shapes that MUST stay byte-for-byte identical with the TS path:
//! - AES-256-GCM blob: `[12-byte IV][ciphertext || 16-byte tag]`
//! - Note frame V2: `[0x02][u32 BE path_len][path UTF-8][content UTF-8]`
//! - Note frame V1 (decode-only): `[u32 BE path_len][path UTF-8][content UTF-8]`,
//!   distinguished from V2 because realistic paths fit under 16 MB so the
//!   high byte of a V1 length prefix is always 0x00
//! - `KeyMaterial.key_salt` and `KeyMaterial.encrypted_vault_key` are
//!   lowercase hex
//! - PBKDF2-HMAC-SHA256, 100k iterations, derives a 32-byte AES-256 key

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hmac::Hmac;
use pbkdf2::pbkdf2;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

pub use crate::merge::MergeResult;
pub use crate::sync::{
    collides_but_differs, collision_conflict_filename, collision_key, conflict_filename,
    is_rename_match, resolve_filename_collision,
};

pub const PBKDF2_ITERATIONS: u32 = 100_000;
pub const IV_BYTES: usize = 12;
pub const SALT_BYTES: usize = 16;
pub const KEY_BYTES: usize = 32;
pub const TAG_BYTES: usize = 16;

const NOTE_FRAME_V2: u8 = 0x02;

#[derive(Debug, thiserror::Error)]
pub enum E2eeError {
    #[error("empty note blob")]
    EmptyBlob,
    #[error("truncated v2 note blob")]
    TruncatedV2,
    #[error("v2 note blob path length out of bounds")]
    V2PathOutOfBounds,
    #[error("v1 note blob filename length out of bounds")]
    V1PathOutOfBounds,
    #[error("unknown note frame version: {0}")]
    UnknownFrame(u8),
    #[error("invalid UTF-8 in note frame: {0}")]
    InvalidUtf8(#[from] std::str::Utf8Error),
    #[error("ciphertext shorter than IV+tag")]
    CipherTooShort,
    #[error("AES-GCM decrypt failed (wrong key, tampered data, or truncated)")]
    Decrypt,
    #[error("AES-GCM encrypt failed")]
    Encrypt,
    #[error("unsupported vault key KDF: {0}")]
    UnsupportedKdf(String),
    #[error("invalid hex: {0}")]
    Hex(#[from] hex::FromHexError),
    #[error("could not unlock vault key. check your vault password.")]
    BadPassword,
}

// ── Random generators ────────────────────────────────────────────────────

pub fn generate_salt() -> [u8; SALT_BYTES] {
    let mut out = [0u8; SALT_BYTES];
    OsRng.fill_bytes(&mut out);
    out
}

pub fn generate_iv() -> [u8; IV_BYTES] {
    let mut out = [0u8; IV_BYTES];
    OsRng.fill_bytes(&mut out);
    out
}

pub fn generate_vault_key() -> [u8; KEY_BYTES] {
    let mut out = [0u8; KEY_BYTES];
    OsRng.fill_bytes(&mut out);
    out
}

// ── Key derivation ───────────────────────────────────────────────────────

pub fn derive_password_key(password: &str, salt: &[u8], iterations: u32) -> [u8; KEY_BYTES] {
    let mut out = [0u8; KEY_BYTES];
    // pbkdf2_hmac never errors for output sizes <= digest output * u32::MAX,
    // so a 32-byte output with SHA-256 is always fine.
    pbkdf2::<Hmac<Sha256>>(password.as_bytes(), salt, iterations, &mut out)
        .expect("PBKDF2-HMAC-SHA256 never errors for 32-byte output");
    out
}

// ── AES-256-GCM encrypt / decrypt ────────────────────────────────────────

/// Encrypt `plaintext`, returning `[IV || ciphertext+tag]`. Generates a
/// fresh random 12-byte IV per call.
pub fn aes_gcm_encrypt(key: &[u8; KEY_BYTES], plaintext: &[u8]) -> Result<Vec<u8>, E2eeError> {
    let iv = generate_iv();
    aes_gcm_encrypt_with_iv(key, &iv, plaintext)
}

/// Encrypt with a caller-supplied IV. Test-only — production callers go
/// through `aes_gcm_encrypt` so the IV is always a fresh CSPRNG draw.
pub fn aes_gcm_encrypt_with_iv(
    key: &[u8; KEY_BYTES],
    iv: &[u8; IV_BYTES],
    plaintext: &[u8],
) -> Result<Vec<u8>, E2eeError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let ct = cipher
        .encrypt(Nonce::from_slice(iv), plaintext)
        .map_err(|_| E2eeError::Encrypt)?;
    let mut out = Vec::with_capacity(IV_BYTES + ct.len());
    out.extend_from_slice(iv);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Decrypt data produced by `aes_gcm_encrypt`. Expects `[IV(12) || ct+tag(>=16)]`.
pub fn aes_gcm_decrypt(key: &[u8; KEY_BYTES], data: &[u8]) -> Result<Vec<u8>, E2eeError> {
    if data.len() < IV_BYTES + TAG_BYTES {
        return Err(E2eeError::CipherTooShort);
    }
    let (iv, ct) = data.split_at(IV_BYTES);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(iv), ct)
        .map_err(|_| E2eeError::Decrypt)
}

// ── Note frame pack / unpack ─────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnpackedNote {
    pub path: String,
    pub content: String,
}

/// Pack a note into the V2 binary frame for encryption. `path` is the
/// relative path INCLUDING the `.md` extension (e.g. `Specs/folder.md`).
pub fn pack_note_v2(path: &str, content: &str) -> Vec<u8> {
    let path_bytes = path.as_bytes();
    let content_bytes = content.as_bytes();
    let mut out = Vec::with_capacity(1 + 4 + path_bytes.len() + content_bytes.len());
    out.push(NOTE_FRAME_V2);
    out.extend_from_slice(&(path_bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(path_bytes);
    out.extend_from_slice(content_bytes);
    out
}

/// Pack a note using the legacy V1 frame. Test-only — production callers
/// always emit V2. Production decoders still accept V1 via `unpack_note`.
pub fn pack_note_v1(filename: &str, content: &str) -> Vec<u8> {
    let name_bytes = filename.as_bytes();
    let content_bytes = content.as_bytes();
    let mut out = Vec::with_capacity(4 + name_bytes.len() + content_bytes.len());
    out.extend_from_slice(&(name_bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(name_bytes);
    out.extend_from_slice(content_bytes);
    out
}

/// Decode a note frame. Auto-detects V1 vs V2 by the first byte.
pub fn unpack_note(data: &[u8]) -> Result<UnpackedNote, E2eeError> {
    if data.is_empty() {
        return Err(E2eeError::EmptyBlob);
    }
    let first = data[0];
    if first == NOTE_FRAME_V2 {
        if data.len() < 5 {
            return Err(E2eeError::TruncatedV2);
        }
        let path_len = u32::from_be_bytes([data[1], data[2], data[3], data[4]]) as usize;
        let path_end = 5usize
            .checked_add(path_len)
            .ok_or(E2eeError::V2PathOutOfBounds)?;
        if path_end > data.len() {
            return Err(E2eeError::V2PathOutOfBounds);
        }
        let path = std::str::from_utf8(&data[5..path_end])?.to_owned();
        let content = std::str::from_utf8(&data[path_end..])?.to_owned();
        return Ok(UnpackedNote { path, content });
    }
    // V1 fallback: high byte of a u32 BE length is 0x00 for any path < 16 MB.
    if first != 0x00 {
        return Err(E2eeError::UnknownFrame(first));
    }
    if data.len() < 4 {
        return Err(E2eeError::V1PathOutOfBounds);
    }
    let name_len = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let name_end = 4usize
        .checked_add(name_len)
        .ok_or(E2eeError::V1PathOutOfBounds)?;
    if name_end > data.len() {
        return Err(E2eeError::V1PathOutOfBounds);
    }
    let path = std::str::from_utf8(&data[4..name_end])?.to_owned();
    let content = std::str::from_utf8(&data[name_end..])?.to_owned();
    Ok(UnpackedNote { path, content })
}

// ── Vault key wrap / unwrap ──────────────────────────────────────────────

/// JSON shape served by `GET /api/collections/{id}/key` and accepted by
/// `PUT /api/collections/{id}/key`. The string fields are lowercase hex.
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

/// Generate a fresh 32-byte vault key and wrap it with a key derived from
/// `password`. Returns the in-memory key plus the serializable material to
/// `PUT /api/collections/{id}/key`.
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

/// Unwrap a previously-wrapped vault key. Errors on unsupported KDF,
/// malformed hex, or AES-GCM decryption failure (wrong password).
pub fn unwrap_vault_key(password: &str, material: &KeyMaterial) -> Result<[u8; KEY_BYTES], E2eeError> {
    if material.key_kdf.kdf != "pbkdf2-sha256" || material.key_kdf.hash != "SHA-256" {
        return Err(E2eeError::UnsupportedKdf(material.key_kdf.kdf.clone()));
    }
    let salt = hex::decode(&material.key_salt)?;
    let encrypted = hex::decode(&material.encrypted_vault_key)?;
    let password_key = derive_password_key(password, &salt, material.key_kdf.iterations);
    let raw = aes_gcm_decrypt(&password_key, &encrypted).map_err(|_| E2eeError::BadPassword)?;
    let mut out = [0u8; KEY_BYTES];
    if raw.len() != KEY_BYTES {
        return Err(E2eeError::BadPassword);
    }
    out.copy_from_slice(&raw);
    Ok(out)
}

// ── Three-way merge convenience ──────────────────────────────────────────

/// Thin wrapper over `crate::merge::three_way_merge` that names the sides
/// explicitly. `remote` is the server's current content; `local` is the
/// client's edited content. The base is whatever the client last synced.
pub fn three_way_merge_text(base: &str, remote: &str, local: &str) -> MergeResult {
    crate::merge::three_way_merge(base, remote, local)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Frame round-trips ──

    #[test]
    fn v2_round_trip_basic() {
        let blob = pack_note_v2("hello.md", "world");
        let n = unpack_note(&blob).unwrap();
        assert_eq!(n.path, "hello.md");
        assert_eq!(n.content, "world");
    }

    #[test]
    fn v2_round_trip_nested_path() {
        let blob = pack_note_v2("Specs/folder/note.md", "# Heading\n\nbody");
        let n = unpack_note(&blob).unwrap();
        assert_eq!(n.path, "Specs/folder/note.md");
        assert_eq!(n.content, "# Heading\n\nbody");
    }

    #[test]
    fn v2_round_trip_unicode_in_path_and_content() {
        let blob = pack_note_v2("カフェ.md", "café\n☕️");
        let n = unpack_note(&blob).unwrap();
        assert_eq!(n.path, "カフェ.md");
        assert_eq!(n.content, "café\n☕️");
    }

    #[test]
    fn v2_round_trip_empty_content() {
        let blob = pack_note_v2("empty.md", "");
        let n = unpack_note(&blob).unwrap();
        assert_eq!(n.path, "empty.md");
        assert_eq!(n.content, "");
    }

    #[test]
    fn v1_decoded_by_unpack() {
        let blob = pack_note_v1("legacy.md", "legacy content");
        let n = unpack_note(&blob).unwrap();
        assert_eq!(n.path, "legacy.md");
        assert_eq!(n.content, "legacy content");
    }

    #[test]
    fn unpack_rejects_empty() {
        assert!(matches!(unpack_note(&[]), Err(E2eeError::EmptyBlob)));
    }

    #[test]
    fn unpack_rejects_truncated_v2() {
        assert!(matches!(
            unpack_note(&[NOTE_FRAME_V2, 0, 0]),
            Err(E2eeError::TruncatedV2)
        ));
    }

    #[test]
    fn unpack_rejects_v2_out_of_bounds() {
        // Length 100, but only 2 bytes of "path" follow.
        let bad = [NOTE_FRAME_V2, 0, 0, 0, 100, b'h', b'i'];
        assert!(matches!(
            unpack_note(&bad),
            Err(E2eeError::V2PathOutOfBounds)
        ));
    }

    #[test]
    fn unpack_rejects_unknown_frame_version() {
        let bad = [0x03, 0, 0, 0, 0];
        assert!(matches!(
            unpack_note(&bad),
            Err(E2eeError::UnknownFrame(0x03))
        ));
    }

    // V2 frame byte layout regression: an external observer must see
    // [0x02][BE u32 path_len][path][content]. If this assertion breaks
    // the wire format diverges from TS clients.
    #[test]
    fn v2_byte_layout_matches_ts() {
        let blob = pack_note_v2("ab", "cd");
        assert_eq!(blob, vec![0x02, 0, 0, 0, 2, b'a', b'b', b'c', b'd']);
    }

    #[test]
    fn v1_byte_layout_matches_ts() {
        let blob = pack_note_v1("ab", "cd");
        assert_eq!(blob, vec![0, 0, 0, 2, b'a', b'b', b'c', b'd']);
    }

    // ── PBKDF2 KAT ──

    // RFC 6070 doesn't include SHA-256 vectors directly, but RFC 7914 §11
    // does. Use the well-known PBKDF2-HMAC-SHA-256 vectors from there.
    #[test]
    fn pbkdf2_hmac_sha256_rfc7914_vector_1() {
        let out = derive_password_key("passwd", b"salt", 1);
        // First 32 bytes of expected 64-byte output:
        //   55ac046e56e3089fec1691c22544b605
        //   f94185216dde0465e68b9d57c20dacbc
        let expected = hex::decode(
            "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc",
        )
        .unwrap();
        assert_eq!(&out[..], &expected[..]);
    }

    // ── AES-GCM ──

    #[test]
    fn aes_gcm_round_trip_random_iv() {
        let key = generate_vault_key();
        let pt = b"the quick brown fox";
        let ct = aes_gcm_encrypt(&key, pt).unwrap();
        // 12-byte IV + 19-byte plaintext + 16-byte tag = 47 bytes.
        assert_eq!(ct.len(), IV_BYTES + pt.len() + TAG_BYTES);
        let recovered = aes_gcm_decrypt(&key, &ct).unwrap();
        assert_eq!(recovered, pt);
    }

    #[test]
    fn aes_gcm_round_trip_fixed_iv() {
        let key = [7u8; KEY_BYTES];
        let iv = [3u8; IV_BYTES];
        let pt = b"deterministic";
        let ct1 = aes_gcm_encrypt_with_iv(&key, &iv, pt).unwrap();
        let ct2 = aes_gcm_encrypt_with_iv(&key, &iv, pt).unwrap();
        // Same key + IV + plaintext must produce identical ciphertext.
        assert_eq!(ct1, ct2);
        assert_eq!(&ct1[..IV_BYTES], &iv);
        assert_eq!(aes_gcm_decrypt(&key, &ct1).unwrap(), pt);
    }

    #[test]
    fn aes_gcm_rejects_tampered_ciphertext() {
        let key = generate_vault_key();
        let mut ct = aes_gcm_encrypt(&key, b"secret").unwrap();
        // Flip a bit in the ciphertext body (past the IV).
        ct[IV_BYTES] ^= 1;
        assert!(matches!(aes_gcm_decrypt(&key, &ct), Err(E2eeError::Decrypt)));
    }

    #[test]
    fn aes_gcm_rejects_wrong_key() {
        let k1 = [1u8; KEY_BYTES];
        let k2 = [2u8; KEY_BYTES];
        let ct = aes_gcm_encrypt(&k1, b"secret").unwrap();
        assert!(matches!(aes_gcm_decrypt(&k2, &ct), Err(E2eeError::Decrypt)));
    }

    #[test]
    fn aes_gcm_rejects_short_ciphertext() {
        let key = [0u8; KEY_BYTES];
        // Only 27 bytes — less than the 12+16 minimum.
        assert!(matches!(
            aes_gcm_decrypt(&key, &[0u8; 27]),
            Err(E2eeError::CipherTooShort)
        ));
    }

    // ── Vault key wrap / unwrap ──

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
        let err = unwrap_vault_key("wrong", &material).unwrap_err();
        assert!(matches!(err, E2eeError::BadPassword));
    }

    #[test]
    fn unwrap_rejects_unsupported_kdf() {
        let (_, mut material) = wrap_vault_key("p").unwrap();
        material.key_kdf.kdf = "scrypt".to_owned();
        let err = unwrap_vault_key("p", &material).unwrap_err();
        assert!(matches!(err, E2eeError::UnsupportedKdf(_)));
    }

    #[test]
    fn key_material_serde_round_trip() {
        let (_, material) = wrap_vault_key("p").unwrap();
        let json = serde_json::to_string(&material).unwrap();
        let round: KeyMaterial = serde_json::from_str(&json).unwrap();
        assert_eq!(material, round);
        // JSON contains the expected field names from the TS side.
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

    // ── End-to-end: encrypted V2 frame round-trip with wrapped key ──

    #[test]
    fn full_pipeline_round_trip() {
        let password = "correct horse battery staple";
        let (vault_key, material) = wrap_vault_key(password).unwrap();

        let blob = pack_note_v2("Inbox/today.md", "remember the milk");
        let ct = aes_gcm_encrypt(&vault_key, &blob).unwrap();

        // Simulate a fresh client: unwrap from material + password only.
        let recovered_key = unwrap_vault_key(password, &material).unwrap();
        let pt = aes_gcm_decrypt(&recovered_key, &ct).unwrap();
        let note = unpack_note(&pt).unwrap();
        assert_eq!(note.path, "Inbox/today.md");
        assert_eq!(note.content, "remember the milk");
    }

    // ── three_way_merge_text wrapper sanity ──

    // Diffy needs unchanged context lines between edits to consider them
    // non-overlapping. Mirror the layout in `merge.rs::tests` so the wrapper
    // exercises a known-clean case without re-asserting the merge algorithm.
    #[test]
    fn merge_clean_non_overlapping() {
        let base = "line 1\nline 2\nline 3\nline 4\nline 5\n";
        let remote = "LINE ONE\nline 2\nline 3\nline 4\nline 5\n";
        let local = "line 1\nline 2\nline 3\nline 4\nLINE FIVE\n";
        match three_way_merge_text(base, remote, local) {
            MergeResult::Clean(out) => {
                assert_eq!(out, "LINE ONE\nline 2\nline 3\nline 4\nLINE FIVE\n");
            }
            MergeResult::Conflict => panic!("expected clean merge"),
        }
    }

    #[test]
    fn merge_conflict_on_overlap() {
        let base = "a\n";
        let remote = "remote\n";
        let local = "local\n";
        assert!(matches!(
            three_way_merge_text(base, remote, local),
            MergeResult::Conflict
        ));
    }
}
