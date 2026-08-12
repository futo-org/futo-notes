use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

pub const MAX_TITLE_LENGTH: usize = 200;
pub const FALLBACK_TITLE: &str = "Untitled";

const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilenameIssueKind {
    ForbiddenChars,
    LeadingDots,
    TrailingDots,
    TooLong,
    Empty,
    ReservedName,
    CaseCollision,
    DepthExceeded,
}

impl FilenameIssueKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ForbiddenChars => "forbidden_chars",
            Self::LeadingDots => "leading_dots",
            Self::TrailingDots => "trailing_dots",
            Self::TooLong => "too_long",
            Self::Empty => "empty",
            Self::ReservedName => "reserved_name",
            Self::CaseCollision => "case_collision",
            Self::DepthExceeded => "depth_exceeded",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilenameIssue {
    pub kind: FilenameIssueKind,
    pub message: String,
}

pub fn collision_key(filename: &str) -> String {
    filename.nfc().collect::<String>().to_lowercase()
}

pub fn collides_but_differs(left: &str, right: &str) -> bool {
    left != right && collision_key(left) == collision_key(right)
}

fn forbidden_title_character(character: char) -> bool {
    matches!(
        character,
        '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
    ) || character.is_control()
}

// ECMAScript TrimString whitespace, kept explicit because Rust's
// `char::is_whitespace` additionally treats U+0085 as whitespace while
// JavaScript correctly reports that control character as forbidden.
fn title_trim_character(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            ..='\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn trim_title_whitespace(title: &str) -> &str {
    title.trim_matches(title_trim_character)
}

pub(super) fn forbidden_path_character(character: char) -> bool {
    matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*') || character.is_control()
}

pub fn is_windows_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_uppercase();
    WINDOWS_RESERVED_NAMES.contains(&stem.as_str())
}

pub fn sanitize_title(title: &str) -> String {
    let filtered = title
        .chars()
        .filter(|character| !forbidden_title_character(*character))
        .collect::<String>();
    let mut stripped = trim_title_whitespace(&filtered);
    loop {
        let settled = trim_title_whitespace(stripped.trim_matches('.'));
        if settled.len() == stripped.len() {
            break;
        }
        stripped = settled;
    }
    if stripped.is_empty() {
        return FALLBACK_TITLE.to_owned();
    }
    if !is_windows_reserved_name(stripped) {
        return stripped.to_owned();
    }
    match stripped.find('.') {
        Some(dot) => format!("{}_{}", &stripped[..dot], &stripped[dot..]),
        None => format!("{stripped}_"),
    }
}

pub fn validate_title(title: &str) -> Vec<FilenameIssue> {
    if trim_title_whitespace(title).is_empty() {
        return vec![FilenameIssue {
            kind: FilenameIssueKind::Empty,
            message: "Title cannot be empty".to_owned(),
        }];
    }

    let mut issues = Vec::new();
    if title.chars().any(forbidden_title_character) {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::ForbiddenChars,
            message: "That character can't be used in a note title".to_owned(),
        });
    }
    if title.starts_with('.') {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::LeadingDots,
            message: "Title cannot start with a dot".to_owned(),
        });
    }
    if title.ends_with('.') {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::TrailingDots,
            message: "Title cannot end with a dot".to_owned(),
        });
    }
    if title.encode_utf16().count() > MAX_TITLE_LENGTH {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::TooLong,
            message: format!("Title cannot exceed {MAX_TITLE_LENGTH} characters"),
        });
    }
    issues
}

pub fn is_valid_title(title: &str) -> bool {
    validate_title(title).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_rules_match_the_public_cross_platform_contract() {
        assert_eq!(sanitize_title(" ..CON.md.. "), "CON_.md");
        assert_eq!(sanitize_title("<>..."), FALLBACK_TITLE);
        assert_eq!(sanitize_title("café 1.4"), "café 1.4");
        assert!(is_windows_reserved_name("lpt9.txt"));

        let kinds = validate_title(".bad<name>.")
            .into_iter()
            .map(|issue| issue.kind)
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![
                FilenameIssueKind::ForbiddenChars,
                FilenameIssueKind::LeadingDots,
                FilenameIssueKind::TrailingDots,
            ]
        );
        assert!(validate_title(&"😀".repeat(MAX_TITLE_LENGTH / 2)).is_empty());
        assert_eq!(
            validate_title(&"😀".repeat(MAX_TITLE_LENGTH / 2 + 1))[0].kind,
            FilenameIssueKind::TooLong
        );
    }

    #[test]
    fn collision_key_folds_case() {
        assert_eq!(collision_key("welcome.md"), collision_key("Welcome.md"));
        assert_eq!(collision_key("README"), collision_key("readme"));
        assert_ne!(collision_key("note-a.md"), collision_key("note-b.md"));
    }

    #[test]
    fn collision_key_folds_nfc_nfd() {
        let nfc = "caf\u{00E9}.md";
        let nfd = "cafe\u{0301}.md";
        assert_ne!(nfc, nfd);
        assert_eq!(collision_key(nfc), collision_key(nfd));
    }

    #[test]
    fn collides_but_differs_detects_case_and_norm_only() {
        assert!(collides_but_differs("note", "Note"));
        assert!(collides_but_differs("caf\u{00E9}", "cafe\u{0301}"));
        assert!(!collides_but_differs("Note", "Note"));
        assert!(!collides_but_differs("note", "other"));
    }

    #[test]
    fn validate_title_is_readonly() {
        let title = "hello<world>";
        assert_eq!(validate_title(title), validate_title(title));
        assert_eq!(title, "hello<world>");
    }

    #[test]
    fn sanitize_is_idempotent() {
        for input in [
            "hello<world>",
            "a:b|c*d",
            "normal",
            "café",
            "📝",
            "...",
            "",
            "   spaces   ",
        ] {
            let once = sanitize_title(input);
            assert_eq!(sanitize_title(&once), once, "{input:?}");
        }
    }
}

// Property-based tests. `sanitize_title` is the only thing between a typed title
// and a filename, so its output has to be safe for every input, and re-applying
// it must not keep changing the name.
#[cfg(test)]
pub(super) mod property_tests {
    use proptest::prelude::*;

    use super::*;

    /// Titles whose outer dots and spaces can expose another directory-reference
    /// shaped layer. Its own arm keeps the fixed-point behavior under pressure.
    pub fn directory_reference_title() -> impl Strategy<Value = String> {
        (1usize..3, 1usize..3, 1usize..3).prop_map(|(lead, inner, trail)| {
            format!(
                ".{}{}{}.",
                " ".repeat(lead),
                ".".repeat(inner),
                " ".repeat(trail)
            )
        })
    }

    /// Titles ending in repeated `". "` groups, which must all settle in one
    /// sanitizer call.
    pub fn trailing_dot_space_title() -> impl Strategy<Value = String> {
        (1usize..6).prop_map(|groups| format!("a{}.", ". ".repeat(groups)))
    }

    /// Titles a user could type or a peer could send, including the dot-and-space
    /// soup that stresses the dot-stripping passes. Shared with
    /// `paths::property_tests` so both test modules explore the same title space.
    pub fn arbitrary_title() -> impl Strategy<Value = String> {
        prop_oneof![
            directory_reference_title(),
            trailing_dot_space_title(),
            prop::collection::vec(any::<char>(), 0..24)
                .prop_map(|characters| characters.into_iter().collect()),
            "[a-z<>:\"/\\\\|?* .]{0,20}",
            "[a-z]{1,4}( \\.){0,4}",
            "[A-Z]{3}[0-9]?(\\.[a-z]{1,3})?",
            prop::collection::vec(
                prop_oneof![
                    Just(".".to_owned()),
                    Just("..".to_owned()),
                    Just(" ".to_owned()),
                    "[a-z]{1,2}",
                ],
                0..7,
            )
            .prop_map(|parts| parts.concat()),
        ]
    }

    proptest! {
        /// The path layer treats a sanitized title as a ready-to-use filename, so
        /// it must never come back empty and never carry a character the path
        /// rules forbid.
        #[test]
        fn sanitized_titles_are_usable_filenames(title in arbitrary_title()) {
            let sanitized = sanitize_title(&title);
            prop_assert!(!sanitized.is_empty(), "sanitize_title({title:?}) was empty");
            prop_assert!(
                !sanitized.chars().any(forbidden_title_character),
                "sanitize_title({:?}) kept a forbidden character: {:?}",
                title,
                sanitized,
            );
            prop_assert!(!sanitized.contains('/'), "{sanitized:?}");
            prop_assert!(!sanitized.contains('\\'), "{sanitized:?}");
            prop_assert!(!is_windows_reserved_name(&sanitized), "{sanitized:?}");
        }

        /// Sanitized titles are handed directly to the path layer, so dot-space
        /// inputs must settle to the fallback instead of `"."` or `".."`.
        #[test]
        fn sanitized_titles_are_never_a_directory_reference(title in arbitrary_title()) {
            let sanitized = sanitize_title(&title);
            prop_assert_ne!(sanitized.as_str(), ".", "sanitize_title({:?})", title);
            prop_assert_ne!(sanitized.as_str(), "..", "sanitize_title({:?})", title);
        }

        /// Sync healing reuses the sanitizer, so applying it again must never
        /// rename a title for a second time.
        #[test]
        fn sanitize_title_is_idempotent(title in arbitrary_title()) {
            let once = sanitize_title(&title);
            prop_assert_eq!(sanitize_title(&once), once);
        }
    }
}
