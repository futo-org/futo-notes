use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::rngs::SysRng;
use rand::TryRng;

use super::E2eeError;

pub const IV_BYTES: usize = 12;
pub const KEY_BYTES: usize = 32;
pub const TAG_BYTES: usize = 16;

/// Bytes straight from the operating system's CSPRNG, the one source for
/// every key, salt and IV this module family generates.
pub(super) fn os_random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    SysRng
        .try_fill_bytes(&mut out)
        .expect("the operating system's random number generator failed");
    out
}

pub fn generate_iv() -> [u8; IV_BYTES] {
    os_random_bytes()
}

pub fn aes_gcm_encrypt(key: &[u8; KEY_BYTES], plaintext: &[u8]) -> Result<Vec<u8>, E2eeError> {
    let iv = generate_iv();
    aes_gcm_encrypt_with_iv(key, &iv, plaintext)
}

fn aes_gcm_encrypt_with_iv(
    key: &[u8; KEY_BYTES],
    iv: &[u8; IV_BYTES],
    plaintext: &[u8],
) -> Result<Vec<u8>, E2eeError> {
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
    let ciphertext = cipher
        .encrypt(&Nonce::from(*iv), plaintext)
        .map_err(|_| E2eeError::Encrypt)?;
    let mut encrypted = Vec::with_capacity(IV_BYTES + ciphertext.len());
    encrypted.extend_from_slice(iv);
    encrypted.extend_from_slice(&ciphertext);
    Ok(encrypted)
}

pub fn aes_gcm_decrypt(key: &[u8; KEY_BYTES], data: &[u8]) -> Result<Vec<u8>, E2eeError> {
    if data.len() < IV_BYTES + TAG_BYTES {
        return Err(E2eeError::CipherTooShort);
    }
    let (iv, ciphertext) = data.split_at(IV_BYTES);
    let nonce = Nonce::try_from(iv).expect("split_at yields exactly IV_BYTES");
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
    cipher
        .decrypt(&nonce, ciphertext)
        .map_err(|_| E2eeError::Decrypt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aes_gcm_round_trip_random_iv() {
        let key = [7u8; KEY_BYTES];
        let plaintext = b"the quick brown fox";
        let ciphertext = aes_gcm_encrypt(&key, plaintext).unwrap();
        assert_eq!(ciphertext.len(), IV_BYTES + plaintext.len() + TAG_BYTES);
        let recovered = aes_gcm_decrypt(&key, &ciphertext).unwrap();
        assert_eq!(recovered, plaintext);
    }

    #[test]
    fn aes_gcm_round_trip_fixed_iv() {
        let key = [7u8; KEY_BYTES];
        let iv = [3u8; IV_BYTES];
        let plaintext = b"deterministic";
        let first = aes_gcm_encrypt_with_iv(&key, &iv, plaintext).unwrap();
        let second = aes_gcm_encrypt_with_iv(&key, &iv, plaintext).unwrap();
        assert_eq!(first, second);
        assert_eq!(&first[..IV_BYTES], &iv);
        assert_eq!(aes_gcm_decrypt(&key, &first).unwrap(), plaintext);
    }

    #[test]
    fn aes_gcm_rejects_tampered_ciphertext() {
        let key = [7u8; KEY_BYTES];
        let mut ciphertext = aes_gcm_encrypt(&key, b"secret").unwrap();
        ciphertext[IV_BYTES] ^= 1;
        assert!(matches!(
            aes_gcm_decrypt(&key, &ciphertext),
            Err(E2eeError::Decrypt)
        ));
    }

    #[test]
    fn aes_gcm_rejects_wrong_key() {
        let first_key = [1u8; KEY_BYTES];
        let second_key = [2u8; KEY_BYTES];
        let ciphertext = aes_gcm_encrypt(&first_key, b"secret").unwrap();
        assert!(matches!(
            aes_gcm_decrypt(&second_key, &ciphertext),
            Err(E2eeError::Decrypt)
        ));
    }

    #[test]
    fn aes_gcm_rejects_short_ciphertext() {
        let key = [0u8; KEY_BYTES];
        assert!(matches!(
            aes_gcm_decrypt(&key, &[0u8; 27]),
            Err(E2eeError::CipherTooShort)
        ));
    }

    /// Known answer from an independent AES-256-GCM (Python `cryptography`
    /// 46, `AESGCM`), not from this crate. Every note and vault-key envelope on
    /// the server was written by this function, so these bytes must never move.
    #[test]
    fn aes_gcm_matches_an_independent_implementation() {
        let key: [u8; KEY_BYTES] = std::array::from_fn(|index| index as u8);
        let iv: [u8; IV_BYTES] = std::array::from_fn(|index| 0xa0 + index as u8);
        let plaintext = b"FUTO Notes known-answer plaintext";
        let expected = hex::decode(concat!(
            "a0a1a2a3a4a5a6a7a8a9aaab",
            "a04d286265856dcb0716a7b86915b7b05dcd3763e5d2304cec6247ef11df1079a6",
            "0fd8822e1d54abafe6d7651a2f9d3eb5",
        ))
        .unwrap();
        assert_eq!(
            aes_gcm_encrypt_with_iv(&key, &iv, plaintext).unwrap(),
            expected
        );
        assert_eq!(aes_gcm_decrypt(&key, &expected).unwrap(), plaintext);
    }
}
