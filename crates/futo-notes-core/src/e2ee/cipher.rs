use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::RngCore;

use super::E2eeError;

pub const IV_BYTES: usize = 12;
pub const KEY_BYTES: usize = 32;
pub const TAG_BYTES: usize = 16;

pub fn generate_iv() -> [u8; IV_BYTES] {
    let mut out = [0u8; IV_BYTES];
    OsRng.fill_bytes(&mut out);
    out
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
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(iv), plaintext)
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
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(iv), ciphertext)
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
}
