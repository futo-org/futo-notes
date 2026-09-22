//! The FUTOpay license-key grammar.

use crate::config::KEY_ALPHABET;

const GROUP_COUNT: usize = 8;
const GROUP_LEN: usize = 4;

/// Trim surrounding whitespace and uppercase. This is the form that is stored,
/// compared, and sent to the activation endpoint.
///
/// Internal whitespace is deliberately kept: `"AB12-CD 34-…"` is a typo, not a
/// key, and silently repairing it would accept keys the server never minted.
pub fn normalize_license_key(raw: &str) -> String {
    raw.trim().to_ascii_uppercase()
}

/// Eight hyphen-separated groups of four characters from [`KEY_ALPHABET`],
/// optionally preceded by an org prefix and a hyphen (`FN-AB12-…`).
///
/// Accepts any casing and surrounding whitespace: the input is normalized
/// first.
pub fn is_valid_license_key(raw: &str) -> bool {
    let normalized = normalize_license_key(raw);
    let parts: Vec<&str> = normalized.split('-').collect();
    let groups = match parts.len() {
        GROUP_COUNT => &parts[..],
        // The org prefix is NOT constrained by the spec, and lib-polar takes it
        // from server config, so the client's only bar is that the key stays one
        // whitespace-free token. Anything narrower — a length cap, an alphabet —
        // would be this client refusing a license the server really minted.
        len if len == GROUP_COUNT + 1 => {
            let prefix = parts[0];
            if prefix.is_empty() || prefix.chars().any(char::is_whitespace) {
                return false;
            }
            &parts[1..]
        }
        _ => return false,
    };
    groups
        .iter()
        .all(|group| group.len() == GROUP_LEN && group.chars().all(|c| KEY_ALPHABET.contains(c)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_alphabet_omits_the_characters_that_get_misread() {
        for excluded in ['I', 'L', 'O', '0'] {
            assert!(
                !KEY_ALPHABET.contains(excluded),
                "{excluded} must not be in the key alphabet"
            );
        }
        assert_eq!(KEY_ALPHABET.len(), 32);
    }

    #[test]
    fn normalization_does_not_touch_the_middle_of_a_key() {
        assert_eq!(normalize_license_key(" ab12 cd34 "), "AB12 CD34");
    }
}
