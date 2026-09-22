use aes_gcm::aead::OsRng;
use argon2::{Algorithm, Argon2, Params, Version};
use hmac::Hmac;
use pbkdf2::pbkdf2;
use rand::RngCore;
use sha2::Sha256;

use super::cipher::KEY_BYTES;
use super::E2eeError;

pub const PBKDF2_ITERATIONS: u32 = 100_000;
pub const SALT_BYTES: usize = 16;

/// Argon2id parameters for the hosted vault-password envelope: 64 MiB of
/// memory, 3 passes, 1 lane (ADR 0003). The vault password is the only thing
/// between an operator holding the envelope and the notes, so it is wrapped
/// under a memory-hard KDF rather than PBKDF2.
pub const ARGON2ID_MEMORY_KIB: u32 = 64 * 1024;
pub const ARGON2ID_PASSES: u32 = 3;
pub const ARGON2ID_LANES: u32 = 1;

pub fn generate_salt() -> [u8; SALT_BYTES] {
    let mut out = [0u8; SALT_BYTES];
    OsRng.fill_bytes(&mut out);
    out
}

pub fn derive_password_key(password: &str, salt: &[u8], iterations: u32) -> [u8; KEY_BYTES] {
    let mut out = [0u8; KEY_BYTES];
    pbkdf2::<Hmac<Sha256>>(password.as_bytes(), salt, iterations, &mut out)
        .expect("PBKDF2-HMAC-SHA256 never errors for 32-byte output");
    out
}

/// Derive a 32-byte key from a password with Argon2id. The parameters are
/// arguments rather than constants because an envelope carries the ones it was
/// written with, and unwrapping has to reproduce them exactly.
pub fn derive_argon2id_key(
    password: &str,
    salt: &[u8],
    memory_kib: u32,
    passes: u32,
    lanes: u32,
) -> Result<[u8; KEY_BYTES], E2eeError> {
    let params = Params::new(memory_kib, passes, lanes, Some(KEY_BYTES))
        .map_err(|error| E2eeError::InvalidKdfParams(error.to_string()))?;
    let mut out = [0u8; KEY_BYTES];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|error| E2eeError::InvalidKdfParams(error.to_string()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::e2ee::E2eeError;

    #[test]
    fn argon2id_matches_an_independent_implementation() {
        // Produced by OpenSSL 3.6.0, not by this crate:
        //   openssl kdf -keylen 32 -kdfopt pass:hunter2hunter2 \
        //     -kdfopt hexsalt:000102030405060708090a0b0c0d0e0f \
        //     -kdfopt iter:3 -kdfopt memcost:65536 -kdfopt lanes:1 \
        //     -kdfopt threads:1 ARGON2ID
        let salt: Vec<u8> = (0u8..16).collect();
        let actual = derive_argon2id_key(
            "hunter2hunter2",
            &salt,
            ARGON2ID_MEMORY_KIB,
            ARGON2ID_PASSES,
            ARGON2ID_LANES,
        )
        .unwrap();
        let expected =
            hex::decode("72276abea763e2a12f87e348e3d1811280f9db20b94c75f3d265cc95cb327b36")
                .unwrap();
        assert_eq!(&actual[..], &expected[..]);
    }

    #[test]
    fn argon2id_defaults_are_the_adr_parameters() {
        assert_eq!(ARGON2ID_MEMORY_KIB, 64 * 1024);
        assert_eq!(ARGON2ID_PASSES, 3);
        assert_eq!(ARGON2ID_LANES, 1);
    }

    #[test]
    fn argon2id_rejects_impossible_parameters() {
        let salt = [0u8; SALT_BYTES];
        assert!(matches!(
            derive_argon2id_key("password", &salt, 0, 3, 1),
            Err(E2eeError::InvalidKdfParams(_)),
        ));
        assert!(matches!(
            derive_argon2id_key("password", &salt, ARGON2ID_MEMORY_KIB, 0, 1),
            Err(E2eeError::InvalidKdfParams(_)),
        ));
        assert!(matches!(
            derive_argon2id_key("password", &[0u8; 4], ARGON2ID_MEMORY_KIB, 3, 1),
            Err(E2eeError::InvalidKdfParams(_)),
        ));
    }

    #[test]
    fn pbkdf2_hmac_sha256_matches_rfc7914_vector_1() {
        let actual = derive_password_key("passwd", b"salt", 1);
        let expected =
            hex::decode("55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc")
                .unwrap();
        assert_eq!(&actual[..], &expected[..]);
    }
}
