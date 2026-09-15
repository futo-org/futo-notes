mod cipher;
mod note_frame;
mod password_key;
mod recovery_key;
mod sealed_box;
mod vault_key;

pub use cipher::{aes_gcm_decrypt, aes_gcm_encrypt, generate_iv, IV_BYTES, KEY_BYTES, TAG_BYTES};
pub use note_frame::{pack_note_v2, unpack_note, UnpackedNote};
pub use password_key::{
    derive_argon2id_key, derive_password_key, generate_salt, ARGON2ID_LANES, ARGON2ID_MEMORY_KIB,
    ARGON2ID_PASSES, PBKDF2_ITERATIONS, SALT_BYTES,
};
pub use recovery_key::{RecoveryKey, RECOVERY_KEY_BYTES};
pub use sealed_box::{open_sealed_vault_key, seal_vault_key, PairingKeyPair, PAIRING_KEY_BYTES};
pub use vault_key::{
    generate_vault_key, unwrap_vault_key, unwrap_vault_key_with_recovery_key, wrap_vault_key,
    wrap_vault_key_argon2id, KeyKdf, KeyMaterial, RecoveryKdf,
};

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
    #[error("invalid KDF parameters: {0}")]
    InvalidKdfParams(String),
    #[error("recovery key is not in the expected format")]
    RecoveryKeyFormat,
    #[error("recovery key has a typo: its check character does not match")]
    RecoveryKeyCheck,
    #[error("this vault has no recovery key")]
    NoRecoveryEnvelope,
    #[error("could not unlock vault key. check your recovery key.")]
    BadRecoveryKey,
    #[error("sealed box is shorter than a public key plus an AES-GCM frame")]
    SealedBoxTooShort,
    #[error("pairing public key is unusable (low order)")]
    SealedBoxWeakKey,
}
