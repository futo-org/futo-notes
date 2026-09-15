use std::fmt;

use aes_gcm::aead::OsRng;
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;

use super::cipher::KEY_BYTES;
use super::E2eeError;

/// 128 bits of entropy (ADR 0003). No slow KDF is needed at that size, so the
/// wrap key comes straight out of HKDF.
pub const RECOVERY_KEY_BYTES: usize = 16;

/// Crockford base32: the digits and the uppercase letters, minus I, L, O and U.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/// Crockford's check symbols extend the alphabet to 37 — a prime, which is what
/// makes the check character catch every single-character error and every
/// transposition of two adjacent characters.
const CHECK_ALPHABET: &[u8; 37] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U";
const CHECK_MODULUS: u128 = 37;

/// 7 groups of 4 (ADR 0003) is 28 characters: 27 of Crockford base32 plus the
/// check character. 27 characters hold 135 bits, so the 128-bit key is written
/// most-significant-bit first and padded with 7 zero bits — the same trailing
/// zero padding any base32 encoder uses, just seven bits instead of two.
const DATA_CHARS: usize = 27;
const PAD_BITS: u32 = 7;
const GROUP_SIZE: usize = 4;

/// A recovery key: the third door into a vault, alongside the vault password
/// and an already-unlocked device.
#[derive(Clone, PartialEq, Eq)]
pub struct RecoveryKey([u8; RECOVERY_KEY_BYTES]);

impl RecoveryKey {
    pub fn generate() -> Self {
        let mut bytes = [0u8; RECOVERY_KEY_BYTES];
        OsRng.fill_bytes(&mut bytes);
        Self(bytes)
    }

    pub fn from_bytes(bytes: [u8; RECOVERY_KEY_BYTES]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; RECOVERY_KEY_BYTES] {
        &self.0
    }

    /// Parse what a person typed: case-insensitive, with or without the dashes,
    /// tolerant of whitespace, and applying Crockford's O→0 and I/L→1 aliases.
    /// A mistyped character is caught here, before any network call or decrypt
    /// attempt.
    pub fn parse(input: &str) -> Result<Self, E2eeError> {
        let normalized: Vec<u8> = input
            .bytes()
            .filter(|byte| *byte != b'-' && !byte.is_ascii_whitespace())
            .map(|byte| match byte.to_ascii_uppercase() {
                b'O' => b'0',
                b'I' | b'L' => b'1',
                other => other,
            })
            .collect();
        if normalized.len() != DATA_CHARS + 1 {
            return Err(E2eeError::RecoveryKeyFormat);
        }

        let mut bytes = [0u8; RECOVERY_KEY_BYTES];
        let mut written = 0;
        let mut accumulator: u32 = 0;
        let mut bits: u32 = 0;
        for symbol in &normalized[..DATA_CHARS] {
            let value = ALPHABET
                .iter()
                .position(|candidate| candidate == symbol)
                .ok_or(E2eeError::RecoveryKeyFormat)?;
            accumulator = (accumulator << 5) | value as u32;
            bits += 5;
            // 27 symbols carry 135 bits, so this yields exactly 16 bytes and
            // leaves the 7 padding bits behind.
            if bits >= 8 {
                bits -= 8;
                bytes[written] = (accumulator >> bits) as u8;
                written += 1;
                accumulator &= (1 << bits) - 1;
            }
        }
        debug_assert_eq!(written, RECOVERY_KEY_BYTES);
        debug_assert_eq!(bits, PAD_BITS);
        if accumulator != 0 {
            return Err(E2eeError::RecoveryKeyFormat);
        }

        let key = Self(bytes);
        let typed_check = CHECK_ALPHABET
            .iter()
            .position(|candidate| candidate == &normalized[DATA_CHARS])
            .ok_or(E2eeError::RecoveryKeyFormat)?;
        if typed_check as u128 != key.check_value() {
            return Err(E2eeError::RecoveryKeyCheck);
        }
        Ok(key)
    }

    /// The AES key this recovery key wraps the vault key under. HKDF-SHA256 is
    /// enough because the input is already 128 uniformly random bits.
    pub fn derive_wrap_key(&self, salt: &[u8]) -> [u8; KEY_BYTES] {
        let mut out = [0u8; KEY_BYTES];
        Hkdf::<Sha256>::new(Some(salt), &self.0)
            .expand(b"futo-notes recovery envelope v1", &mut out)
            .expect("HKDF-SHA256 never errors for a 32-byte output");
        out
    }

    fn check_value(&self) -> u128 {
        u128::from_be_bytes(self.0) % CHECK_MODULUS
    }
}

impl fmt::Display for RecoveryKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut symbols = String::with_capacity(DATA_CHARS + 1);
        let mut accumulator: u32 = 0;
        let mut bits: u32 = 0;
        for byte in self.0 {
            accumulator = (accumulator << 8) | byte as u32;
            bits += 8;
            while bits >= 5 {
                bits -= 5;
                symbols.push(ALPHABET[((accumulator >> bits) & 31) as usize] as char);
            }
            accumulator &= (1 << bits) - 1;
        }
        // The last 7 bits of the 135 are padding; they are what turns 26
        // characters of base32 into the 27 that leave room for the check
        // character in seven groups of four.
        accumulator <<= PAD_BITS;
        bits += PAD_BITS;
        while bits >= 5 {
            bits -= 5;
            symbols.push(ALPHABET[((accumulator >> bits) & 31) as usize] as char);
        }
        debug_assert_eq!(symbols.len(), DATA_CHARS);
        symbols.push(CHECK_ALPHABET[self.check_value() as usize] as char);

        for (group, chunk) in symbols.as_bytes().chunks(GROUP_SIZE).enumerate() {
            if group > 0 {
                formatter.write_str("-")?;
            }
            formatter.write_str(std::str::from_utf8(chunk).expect("ASCII alphabet"))?;
        }
        Ok(())
    }
}

/// Redacted on purpose: a recovery key printed into a log or a panic message is
/// a vault handed over.
impl fmt::Debug for RecoveryKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RecoveryKey(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::e2ee::E2eeError;

    #[test]
    fn generated_key_formats_as_seven_groups_of_four() {
        let key = RecoveryKey::generate();
        let formatted = key.to_string();
        let groups: Vec<&str> = formatted.split('-').collect();
        assert_eq!(groups.len(), 7);
        assert!(groups.iter().all(|group| group.len() == 4));
        assert_eq!(formatted.len(), 34);
    }

    #[test]
    fn generated_keys_carry_128_bits_and_differ() {
        let first = RecoveryKey::generate();
        let second = RecoveryKey::generate();
        assert_eq!(first.as_bytes().len(), RECOVERY_KEY_BYTES);
        assert_eq!(RECOVERY_KEY_BYTES * 8, 128);
        assert_ne!(first.as_bytes(), second.as_bytes());
    }

    #[test]
    fn format_parse_round_trip() {
        for _ in 0..64 {
            let key = RecoveryKey::generate();
            let parsed = RecoveryKey::parse(&key.to_string()).unwrap();
            assert_eq!(parsed.as_bytes(), key.as_bytes());
        }
    }

    #[test]
    fn parse_accepts_lowercase_without_dashes_and_with_spaces() {
        let key = RecoveryKey::generate();
        let formatted = key.to_string();
        let lowercase = formatted.to_lowercase();
        let undashed = formatted.replace('-', "");
        let spaced = formatted.replace('-', " ");
        for variant in [lowercase, undashed, spaced, format!("  {formatted}  ")] {
            assert_eq!(
                RecoveryKey::parse(&variant).unwrap().as_bytes(),
                key.as_bytes(),
                "variant {variant} did not parse back to the same key",
            );
        }
    }

    #[test]
    fn parse_applies_crockford_letter_aliases() {
        let key = RecoveryKey::from_bytes([0u8; RECOVERY_KEY_BYTES]);
        let formatted = key.to_string();
        // Crockford decodes O as 0 and I/L as 1. An all-zero key is all '0's
        // plus its check character, so swapping every '0' for 'O' must parse
        // back to the same key.
        let with_letter_o = formatted.replace('0', "O");
        assert_ne!(with_letter_o, formatted);
        assert_eq!(
            RecoveryKey::parse(&with_letter_o).unwrap().as_bytes(),
            key.as_bytes(),
        );
    }

    #[test]
    fn parse_rejects_a_wrong_check_character_distinctly() {
        let key = RecoveryKey::generate();
        let mut chars: Vec<char> = key.to_string().chars().collect();
        let last = chars.len() - 1;
        // Move the check character one step along its own alphabet.
        chars[last] = if chars[last] == 'Z' { 'Y' } else { 'Z' };
        let typo: String = chars.into_iter().collect();
        assert!(matches!(
            RecoveryKey::parse(&typo),
            Err(E2eeError::RecoveryKeyCheck),
        ));
    }

    #[test]
    fn parse_catches_a_single_character_typo_in_the_body() {
        let key = RecoveryKey::generate();
        let formatted = key.to_string();
        let mut caught = 0;
        for (index, ch) in formatted.char_indices() {
            if ch == '-' {
                continue;
            }
            let replacement = if ch == 'X' { 'Y' } else { 'X' };
            let mut typo = formatted.clone();
            typo.replace_range(index..index + 1, &replacement.to_string());
            match RecoveryKey::parse(&typo) {
                Err(E2eeError::RecoveryKeyCheck) | Err(E2eeError::RecoveryKeyFormat) => caught += 1,
                other => panic!("typo at {index} was not caught: {other:?}"),
            }
        }
        assert_eq!(caught, 28);
    }

    #[test]
    fn parse_catches_a_transposition() {
        // Transposing two adjacent, different characters must not survive the
        // check character — that is why it is mod 37 rather than mod 32.
        let key = RecoveryKey::generate();
        let mut chars: Vec<char> = key.to_string().replace('-', "").chars().collect();
        let pair = (0..chars.len() - 1)
            .find(|&index| chars[index] != chars[index + 1])
            .expect("a random key has two adjacent characters that differ");
        chars.swap(pair, pair + 1);
        let transposed: String = chars.into_iter().collect();
        assert!(matches!(
            RecoveryKey::parse(&transposed),
            Err(E2eeError::RecoveryKeyCheck) | Err(E2eeError::RecoveryKeyFormat),
        ));
    }

    #[test]
    fn parse_rejects_wrong_length() {
        let key = RecoveryKey::generate();
        let formatted = key.to_string();
        let short = &formatted[..formatted.len() - 1];
        let long = format!("{formatted}0");
        for variant in [short.to_owned(), long, String::new()] {
            assert!(matches!(
                RecoveryKey::parse(&variant),
                Err(E2eeError::RecoveryKeyFormat),
            ));
        }
    }

    #[test]
    fn parse_rejects_characters_outside_the_alphabet() {
        let key = RecoveryKey::generate();
        let mut chars: Vec<char> = key.to_string().chars().collect();
        chars[0] = 'U'; // excluded from the data alphabet by Crockford
        let with_u: String = chars.iter().collect();
        assert!(matches!(
            RecoveryKey::parse(&with_u),
            Err(E2eeError::RecoveryKeyFormat),
        ));
        chars[0] = '?';
        let with_punctuation: String = chars.into_iter().collect();
        assert!(matches!(
            RecoveryKey::parse(&with_punctuation),
            Err(E2eeError::RecoveryKeyFormat),
        ));
    }

    #[test]
    fn debug_does_not_leak_the_key() {
        let key = RecoveryKey::generate();
        let debug = format!("{key:?}");
        assert!(!debug.contains(&key.to_string()));
        assert!(!debug.contains(&hex::encode(key.as_bytes())));
    }

    #[test]
    fn wrap_key_is_salt_dependent_and_deterministic() {
        let key = RecoveryKey::generate();
        let salt = [9u8; 16];
        assert_eq!(key.derive_wrap_key(&salt), key.derive_wrap_key(&salt));
        assert_ne!(key.derive_wrap_key(&salt), key.derive_wrap_key(&[8u8; 16]));
        assert_ne!(
            key.derive_wrap_key(&salt),
            RecoveryKey::generate().derive_wrap_key(&salt),
        );
    }
}
