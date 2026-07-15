use aes_gcm::aead::OsRng;
use hmac::Hmac;
use pbkdf2::pbkdf2;
use rand::RngCore;
use sha2::Sha256;

use super::cipher::KEY_BYTES;

pub const PBKDF2_ITERATIONS: u32 = 100_000;
pub const SALT_BYTES: usize = 16;

pub(super) fn generate_salt() -> [u8; SALT_BYTES] {
    let mut out = [0u8; SALT_BYTES];
    OsRng.fill_bytes(&mut out);
    out
}

pub(super) fn derive_password_key(password: &str, salt: &[u8], iterations: u32) -> [u8; KEY_BYTES] {
    let mut out = [0u8; KEY_BYTES];
    pbkdf2::<Hmac<Sha256>>(password.as_bytes(), salt, iterations, &mut out)
        .expect("PBKDF2-HMAC-SHA256 never errors for 32-byte output");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pbkdf2_hmac_sha256_matches_rfc7914_vector_1() {
        let actual = derive_password_key("passwd", b"salt", 1);
        let expected =
            hex::decode("55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc")
                .unwrap();
        assert_eq!(&actual[..], &expected[..]);
    }
}
