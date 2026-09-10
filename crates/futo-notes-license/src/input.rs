//! Recognising the three shapes a user can hand us, and the deep link.
//!
//! Recognition is **structural**: it answers "which of the three shapes is
//! this?", never "is this a real license?". That split is what lets the deep
//! link behave as specified — a link at the defined path with a garbage key is
//! answered with one "isn't valid" toast, while a link at any other path is
//! ignored silently.

use crate::config::{DEEP_LINK_HOST, DEEP_LINK_SCHEME};
use crate::key::normalize_license_key;

/// The two plain strings a shell stores: nothing else is persisted, and never
/// in the vault or the OS keyring.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LicensePair {
    /// Normalized (trimmed, uppercased) license key.
    pub key: String,
    /// The activation exactly as issued — base64url is case-sensitive.
    pub activation: String,
}

/// What a pasted string turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LicenseInput {
    /// Shape 1: a key on its own. Verifying it needs one activation request.
    BareKey(String),
    /// Shapes 2 and 3 (`key/activation`, and the `futonotes://` URL). Verifies
    /// fully offline.
    Pair(LicensePair),
}

/// The single recognizer behind the License key field and the deep-link
/// handler. `None` means "this is not a license in any accepted shape".
pub fn recognize_input(raw: &str) -> Option<LicenseInput> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(pair) = parse_deep_link(trimmed) {
        return Some(LicenseInput::Pair(pair));
    }
    // Some other scheme's URL — including this app's own scheme at a path we do
    // not define. Never a key.
    if trimmed.contains("://") {
        return None;
    }
    match trimmed.split_once('/') {
        Some((key, activation)) => {
            if key.is_empty() || activation.is_empty() || activation.contains('/') {
                return None;
            }
            Some(LicenseInput::Pair(LicensePair {
                key: normalize_license_key(key),
                activation: activation.to_string(),
            }))
        }
        None => Some(LicenseInput::BareKey(normalize_license_key(trimmed))),
    }
}

/// `futonotes://license/{key}/{activation}`, and nothing else.
///
/// Scheme and host are matched case-insensitively (URLs are); the activation is
/// not, because base64url is case-sensitive. A query string or fragment the
/// checkout page appends is dropped. Any other host or path returns `None`,
/// which the shells must treat as "ignore silently" — no toast, no navigation.
pub fn parse_deep_link(raw: &str) -> Option<LicensePair> {
    let trimmed = raw.trim();
    let prefix = format!("{DEEP_LINK_SCHEME}://");
    let Some(candidate_prefix) = trimmed.get(..prefix.len()) else {
        return None;
    };
    if !candidate_prefix.eq_ignore_ascii_case(&prefix) {
        return None;
    }
    let rest = &trimmed[prefix.len()..];
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let segments: Vec<&str> = rest.split('/').filter(|part| !part.is_empty()).collect();
    let [host, key, activation] = segments.as_slice() else {
        return None;
    };
    if !host.eq_ignore_ascii_case(DEEP_LINK_HOST) {
        return None;
    }
    Some(LicensePair {
        key: normalize_license_key(key),
        activation: activation.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deep_link_reaching_the_text_field_is_the_same_answer_as_the_url_handler() {
        let url = "futonotes://license/FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78/v2.a.b";
        assert_eq!(
            recognize_input(url),
            parse_deep_link(url).map(LicenseInput::Pair)
        );
    }

    #[test]
    fn the_activations_case_survives_normalization() {
        let Some(LicenseInput::Pair(pair)) = recognize_input("fn-ab12-cd34/v2.AbC.dEf") else {
            panic!("expected a pair");
        };
        assert_eq!(pair.key, "FN-AB12-CD34");
        assert_eq!(pair.activation, "v2.AbC.dEf");
    }

    #[test]
    fn unicode_text_shorter_than_the_deep_link_prefix_is_rejected_without_panicking() {
        assert_eq!(
            recognize_input("a🍎🍎🍎"),
            Some(LicenseInput::BareKey("A🍎🍎🍎".into()))
        );
    }
}
