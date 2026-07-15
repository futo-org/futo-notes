use std::collections::HashSet;

pub fn collision_conflict_filename(canonical_name: &str, loser_object_id: &str) -> String {
    let (base, extension) = split_conflict_name_parts(canonical_name);
    let short_id = object_id_short(loser_object_id);
    format!("{base} (conflict {short_id}){extension}")
}

pub fn conflict_filename(original: &str, date: &str, existing: &HashSet<String>) -> String {
    let (base, extension) = split_conflict_name_parts(original);
    let candidate = format!("{base} (conflict {date}){extension}");
    if !existing.contains(&candidate) {
        return candidate;
    }

    for counter in 2u64.. {
        let candidate = format!("{base} (conflict {date} {counter}){extension}");
        if !existing.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn object_id_short(object_id: &str) -> String {
    let cleaned = object_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect::<String>();
    if cleaned.is_empty() {
        "object".to_owned()
    } else {
        cleaned
    }
}

fn split_conflict_name_parts(original: &str) -> (&str, &str) {
    let (base, extension) = if let Some(base) = original.strip_suffix(".md") {
        (base, ".md")
    } else if let Some((base, _)) = original.rsplit_once('.') {
        if base.is_empty() {
            (original, ".md")
        } else {
            (base, &original[base.len()..])
        }
    } else {
        (original, ".md")
    };

    (strip_trailing_conflict_suffixes(base), extension)
}

fn strip_trailing_conflict_suffixes(mut base: &str) -> &str {
    const OPEN: &str = " (conflict ";

    loop {
        let trimmed = base.trim_end_matches(' ');
        let Some(without_close) = trimmed.strip_suffix(')') else {
            return base;
        };
        let Some(open_at) = without_close.rfind(OPEN) else {
            return base;
        };
        let token = &trimmed[open_at + OPEN.len()..trimmed.len() - 1];
        if !is_generated_conflict_token(token) {
            return base;
        }
        base = &trimmed[..open_at];
    }
}

fn is_generated_conflict_token(token: &str) -> bool {
    is_date_conflict_token(token) || is_object_conflict_token(token)
}

fn is_date_conflict_token(token: &str) -> bool {
    let Some(date) = token.get(..10) else {
        return false;
    };
    let bytes = date.as_bytes();
    let has_date_shape = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if !has_date_shape {
        return false;
    }

    match token.get(10..) {
        Some("") => true,
        Some(rest) if rest.starts_with(' ') => {
            let counter = &rest[1..];
            !counter.is_empty() && counter.as_bytes().iter().all(u8::is_ascii_digit)
        }
        _ => false,
    }
}

fn is_object_conflict_token(token: &str) -> bool {
    token == "object"
        || (token.len() == 8 && token.as_bytes().iter().all(u8::is_ascii_hexdigit))
        || (token.len() == 8
            && token.as_bytes().iter().all(u8::is_ascii_alphanumeric)
            && token.as_bytes().iter().any(u8::is_ascii_digit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_filename_basic() {
        assert_eq!(
            conflict_filename("note.md", "2026-03-28", &HashSet::new()),
            "note (conflict 2026-03-28).md"
        );
    }

    #[test]
    fn conflict_filename_with_collision() {
        let existing = HashSet::from(["note (conflict 2026-03-28).md".to_owned()]);
        assert_eq!(
            conflict_filename("note.md", "2026-03-28", &existing),
            "note (conflict 2026-03-28 2).md"
        );
    }

    #[test]
    fn conflict_filename_multiple_collisions() {
        let existing = HashSet::from([
            "note (conflict 2026-03-28).md".to_owned(),
            "note (conflict 2026-03-28 2).md".to_owned(),
            "note (conflict 2026-03-28 3).md".to_owned(),
        ]);
        assert_eq!(
            conflict_filename("note.md", "2026-03-28", &existing),
            "note (conflict 2026-03-28 4).md"
        );
    }

    #[test]
    fn conflict_filename_no_extension() {
        assert_eq!(
            conflict_filename("note", "2026-03-28", &HashSet::new()),
            "note (conflict 2026-03-28).md"
        );
    }

    #[test]
    fn conflict_filename_preserves_non_md_extension() {
        assert_eq!(
            conflict_filename("image.png", "2026-03-28", &HashSet::new()),
            "image (conflict 2026-03-28).png"
        );
    }

    #[test]
    fn conflict_filename_does_not_stack_on_a_parked_copy() {
        assert_eq!(
            conflict_filename(
                "note (conflict 2026-03-28).md",
                "2026-03-29",
                &HashSet::new(),
            ),
            "note (conflict 2026-03-29).md"
        );
    }

    #[test]
    fn collision_conflict_filename_does_not_stack_on_a_parked_copy() {
        assert_eq!(
            collision_conflict_filename(
                "futo notes top priorities (conflict 019f3d55).md",
                "019f3d9d-aaaa",
            ),
            "futo notes top priorities (conflict 019f3d9d).md"
        );
    }

    #[test]
    fn collision_conflict_filename_peels_deep_stacks_flat() {
        assert_eq!(
            collision_conflict_filename(
                "foo (conflict deadbeef) (conflict cafebabe) (conflict facefeed).md",
                "019f3d9d",
            ),
            "foo (conflict 019f3d9d).md"
        );
    }

    #[test]
    fn conflict_naming_is_idempotent_across_rounds() {
        let once = collision_conflict_filename("foo.md", "019f3d9d");
        assert_eq!(collision_conflict_filename(&once, "019f3d9d"), once);
    }

    #[test]
    fn conflict_naming_preserves_extension_when_stripping_stack() {
        assert_eq!(
            collision_conflict_filename("image (conflict deadbeef).png", "019f3d9d"),
            "image (conflict 019f3d9d).png"
        );
    }

    #[test]
    fn conflict_naming_preserves_user_title_that_mentions_conflict() {
        assert_eq!(
            conflict_filename(
                "plan (conflict resolution).md",
                "2026-03-29",
                &HashSet::new(),
            ),
            "plan (conflict resolution) (conflict 2026-03-29).md"
        );
        assert_eq!(
            collision_conflict_filename("plan (conflict resolution).md", "019f3d9d"),
            "plan (conflict resolution) (conflict 019f3d9d).md"
        );
    }

    #[test]
    fn conflict_naming_peels_date_counter_suffix() {
        assert_eq!(
            conflict_filename(
                "note (conflict 2026-03-28 2).md",
                "2026-03-29",
                &HashSet::new(),
            ),
            "note (conflict 2026-03-29).md"
        );
    }

    #[test]
    fn conflict_naming_leaves_user_title_with_nested_parens_untouched() {
        assert_eq!(
            collision_conflict_filename("plan (conflict (draft)).md", "019f3d9d"),
            "plan (conflict (draft)) (conflict 019f3d9d).md"
        );
    }

    #[test]
    fn collision_conflict_filename_is_pure_function_of_object_id() {
        let first = collision_conflict_filename("welcome.md", "abcdef0123456789-objectid");
        let second = collision_conflict_filename("welcome.md", "abcdef0123456789-objectid");
        assert_eq!(first, second);
        assert_eq!(first, "welcome (conflict abcdef01).md");
    }

    #[test]
    fn collision_conflict_filename_independent_of_namespace_set() {
        assert_eq!(
            collision_conflict_filename("note.md", "OID-1234abcd-zz"),
            "note (conflict OID1234a).md"
        );
    }

    #[test]
    fn collision_conflict_filename_preserves_extension() {
        assert_eq!(
            collision_conflict_filename("image.png", "deadbeefcafe"),
            "image (conflict deadbeef).png"
        );
        assert_eq!(
            collision_conflict_filename("readme", "0011223344"),
            "readme (conflict 00112233).md"
        );
    }

    #[test]
    fn collision_conflict_filename_handles_degenerate_object_id() {
        assert_eq!(
            collision_conflict_filename("note.md", "----"),
            "note (conflict object).md"
        );
    }
}
