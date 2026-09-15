use aes_gcm::aead::OsRng;
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

use super::cipher::{aes_gcm_decrypt, aes_gcm_encrypt, IV_BYTES, KEY_BYTES, TAG_BYTES};
use super::E2eeError;

pub const PAIRING_KEY_BYTES: usize = 32;

/// Binds the derived key to this use and this version, so a shared secret can
/// never be reused for anything else.
const PAIRING_INFO: &[u8] = b"futo-notes pairing v1";

/// The one-time X25519 keypair a device about to be paired puts in its QR code.
/// The already-unlocked device seals the vault key to `public`; only the holder
/// of `secret` can open it.
#[derive(Clone, PartialEq, Eq)]
pub struct PairingKeyPair {
    pub secret: [u8; PAIRING_KEY_BYTES],
    pub public: [u8; PAIRING_KEY_BYTES],
}

impl PairingKeyPair {
    pub fn generate() -> Self {
        let mut secret = [0u8; PAIRING_KEY_BYTES];
        OsRng.fill_bytes(&mut secret);
        Self::from_secret(secret)
    }

    pub fn from_secret(secret: [u8; PAIRING_KEY_BYTES]) -> Self {
        let public = PublicKey::from(&StaticSecret::from(secret)).to_bytes();
        Self { secret, public }
    }
}

/// Redacted on purpose: the secret half must never reach a log.
impl std::fmt::Debug for PairingKeyPair {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PairingKeyPair")
            .field("public", &hex::encode(self.public))
            .field("secret", &"<redacted>")
            .finish()
    }
}

/// Seal a 32-byte vault key to a pairing public key, sealed-box style: a fresh
/// ephemeral keypair per call, an HKDF-SHA256 key over the X25519 shared secret
/// bound to both public keys, and the crate's AES-256-GCM. The output is the
/// ephemeral public key followed by that ciphertext.
pub fn seal_vault_key(
    recipient_public: &[u8; PAIRING_KEY_BYTES],
    vault_key: &[u8; KEY_BYTES],
) -> Result<Vec<u8>, E2eeError> {
    let ephemeral = PairingKeyPair::generate();
    let key = sealed_box_key(
        &ephemeral.secret,
        recipient_public,
        &ephemeral.public,
        recipient_public,
    )?;
    let ciphertext = aes_gcm_encrypt(&key, vault_key)?;
    let mut sealed = Vec::with_capacity(PAIRING_KEY_BYTES + ciphertext.len());
    sealed.extend_from_slice(&ephemeral.public);
    sealed.extend_from_slice(&ciphertext);
    Ok(sealed)
}

/// Open a sealed vault key with the pairing secret. Any other secret, or a
/// tampered box, fails to decrypt.
pub fn open_sealed_vault_key(
    secret: &[u8; PAIRING_KEY_BYTES],
    sealed: &[u8],
) -> Result<[u8; KEY_BYTES], E2eeError> {
    if sealed.len() < PAIRING_KEY_BYTES + IV_BYTES + TAG_BYTES {
        return Err(E2eeError::SealedBoxTooShort);
    }
    let (prefix, ciphertext) = sealed.split_at(PAIRING_KEY_BYTES);
    let mut ephemeral_public = [0u8; PAIRING_KEY_BYTES];
    ephemeral_public.copy_from_slice(prefix);
    let recipient_public = PairingKeyPair::from_secret(*secret).public;
    let key = sealed_box_key(
        secret,
        &ephemeral_public,
        &ephemeral_public,
        &recipient_public,
    )?;
    let raw = aes_gcm_decrypt(&key, ciphertext)?;
    if raw.len() != KEY_BYTES {
        return Err(E2eeError::Decrypt);
    }
    let mut vault_key = [0u8; KEY_BYTES];
    vault_key.copy_from_slice(&raw);
    Ok(vault_key)
}

/// X25519 plus HKDF-SHA256. Both public keys go into the HKDF info, so the key
/// is bound to the pair of devices and a box cannot be replayed as one sealed
/// to somebody else.
fn sealed_box_key(
    our_secret: &[u8; PAIRING_KEY_BYTES],
    their_public: &[u8; PAIRING_KEY_BYTES],
    ephemeral_public: &[u8; PAIRING_KEY_BYTES],
    recipient_public: &[u8; PAIRING_KEY_BYTES],
) -> Result<[u8; KEY_BYTES], E2eeError> {
    let shared = StaticSecret::from(*our_secret).diffie_hellman(&PublicKey::from(*their_public));
    // A low-order public key makes every secret agree on the same all-zero
    // shared secret, which would let anyone open the box.
    if !shared.was_contributory() {
        return Err(E2eeError::SealedBoxWeakKey);
    }
    let mut info = Vec::with_capacity(PAIRING_INFO.len() + 2 * PAIRING_KEY_BYTES);
    info.extend_from_slice(PAIRING_INFO);
    info.extend_from_slice(ephemeral_public);
    info.extend_from_slice(recipient_public);
    let mut out = [0u8; KEY_BYTES];
    Hkdf::<Sha256>::new(None, shared.as_bytes())
        .expand(&info, &mut out)
        .expect("HKDF-SHA256 never errors for a 32-byte output");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::e2ee::{generate_vault_key, E2eeError, IV_BYTES, TAG_BYTES};

    #[test]
    fn seal_open_round_trip() {
        let recipient = PairingKeyPair::generate();
        let vault_key = generate_vault_key();
        let sealed = seal_vault_key(&recipient.public, &vault_key).unwrap();
        assert_eq!(
            open_sealed_vault_key(&recipient.secret, &sealed).unwrap(),
            vault_key,
        );
    }

    #[test]
    fn sealed_output_is_the_ephemeral_public_key_plus_the_ciphertext() {
        let recipient = PairingKeyPair::generate();
        let sealed = seal_vault_key(&recipient.public, &generate_vault_key()).unwrap();
        assert_eq!(
            sealed.len(),
            PAIRING_KEY_BYTES + IV_BYTES + KEY_BYTES + TAG_BYTES,
        );
        assert_ne!(&sealed[..PAIRING_KEY_BYTES], &recipient.public[..]);
    }

    #[test]
    fn sealing_twice_never_repeats_a_ciphertext() {
        let recipient = PairingKeyPair::generate();
        let vault_key = generate_vault_key();
        let first = seal_vault_key(&recipient.public, &vault_key).unwrap();
        let second = seal_vault_key(&recipient.public, &vault_key).unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn open_rejects_the_wrong_secret_key() {
        let recipient = PairingKeyPair::generate();
        let impostor = PairingKeyPair::generate();
        let sealed = seal_vault_key(&recipient.public, &generate_vault_key()).unwrap();
        assert!(matches!(
            open_sealed_vault_key(&impostor.secret, &sealed),
            Err(E2eeError::Decrypt),
        ));
    }

    #[test]
    fn open_rejects_a_tampered_ephemeral_public_key() {
        let recipient = PairingKeyPair::generate();
        let mut sealed = seal_vault_key(&recipient.public, &generate_vault_key()).unwrap();
        sealed[0] ^= 1;
        assert!(matches!(
            open_sealed_vault_key(&recipient.secret, &sealed),
            Err(E2eeError::Decrypt) | Err(E2eeError::SealedBoxWeakKey),
        ));
    }

    #[test]
    fn open_rejects_a_tampered_ciphertext() {
        let recipient = PairingKeyPair::generate();
        let mut sealed = seal_vault_key(&recipient.public, &generate_vault_key()).unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert!(matches!(
            open_sealed_vault_key(&recipient.secret, &sealed),
            Err(E2eeError::Decrypt),
        ));
    }

    #[test]
    fn open_rejects_a_truncated_box() {
        let recipient = PairingKeyPair::generate();
        let sealed = seal_vault_key(&recipient.public, &generate_vault_key()).unwrap();
        assert!(matches!(
            open_sealed_vault_key(&recipient.secret, &sealed[..sealed.len() - 1]),
            Err(E2eeError::Decrypt),
        ));
        assert!(matches!(
            open_sealed_vault_key(&recipient.secret, &sealed[..PAIRING_KEY_BYTES]),
            Err(E2eeError::SealedBoxTooShort),
        ));
    }

    #[test]
    fn seal_rejects_a_low_order_public_key() {
        // A pairing code carrying a low-order point would make the sealed box
        // openable by anyone, because every secret derives the same all-zero
        // shared secret from it.
        let low_order = [0u8; PAIRING_KEY_BYTES];
        assert!(matches!(
            seal_vault_key(&low_order, &generate_vault_key()),
            Err(E2eeError::SealedBoxWeakKey),
        ));
    }

    #[test]
    fn generated_pairs_are_unique_and_agree_on_the_public_key() {
        let first = PairingKeyPair::generate();
        let second = PairingKeyPair::generate();
        assert_ne!(first.secret, second.secret);
        assert_ne!(first.public, second.public);
        assert_eq!(
            PairingKeyPair::from_secret(first.secret).public,
            first.public
        );
    }

    #[test]
    fn debug_does_not_leak_the_secret() {
        let pair = PairingKeyPair::generate();
        let debug = format!("{pair:?}");
        assert!(!debug.contains(&hex::encode(pair.secret)));
    }
}
