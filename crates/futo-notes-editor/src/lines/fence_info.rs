//! An opening fence's info string: a language, then `key:value` options
//! (`name:`, `hl:`, `ll:`). Reading it never changes the text; anything it
//! does not recognise is ignored.
use crate::CodeLineMark;
use std::ops::RangeInclusive;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct FenceInfo {
    /// One whitespace-free word, case kept.
    pub language: Option<String>,
    pub name: Option<String>,
    /// Lines counted from 1 at the block's first code line.
    pub highlight: Vec<RangeInclusive<u64>>,
    pub lowlight: Vec<RangeInclusive<u64>>,
}

const FENCE_INFO_KEYS: [&str; 3] = ["name:", "hl:", "ll:"];

impl FenceInfo {
    /// The mark on code line `line_number`; a line in both lists is highlighted.
    pub fn mark(&self, line_number: u32) -> Option<CodeLineMark> {
        let line_number = u64::from(line_number);
        let holds =
            |ranges: &[RangeInclusive<u64>]| ranges.iter().any(|r| r.contains(&line_number));
        if holds(&self.highlight) {
            return Some(CodeLineMark::Highlight);
        }
        holds(&self.lowlight).then_some(CodeLineMark::Lowlight)
    }
}

/// Where each key of `info` starts, in order. A key opens an option only at
/// the start or after whitespace, so a value may hold spaces
/// (`name:api handlers.go`) and `notes.hl:3.go` stays one value.
fn fence_info_keys(info: &str) -> Vec<(usize, &'static str)> {
    let mut keys = Vec::new();
    let mut at_boundary = true;
    for (at, character) in info.char_indices() {
        if at_boundary {
            if let Some(key) = FENCE_INFO_KEYS
                .iter()
                .find(|key| info[at..].starts_with(*key))
            {
                keys.push((at, *key));
            }
        }
        at_boundary = character.is_whitespace();
    }
    keys
}

/// Read the text after an opening fence's backticks or tildes. A repeated
/// key keeps its last value.
pub(crate) fn read_fence_info(info: &str) -> FenceInfo {
    let keys = fence_info_keys(info);
    let language_end = keys.first().map_or(info.len(), |(at, _)| *at);
    let mut read = FenceInfo {
        language: info[..language_end]
            .split_whitespace()
            .next()
            .map(str::to_owned),
        ..FenceInfo::default()
    };
    for (index, (at, key)) in keys.iter().enumerate() {
        let value_end = keys.get(index + 1).map_or(info.len(), |(next, _)| *next);
        let value = info[at + key.len()..value_end].trim();
        match *key {
            "name:" => read.name = (!value.is_empty()).then(|| value.to_owned()),
            "hl:" => read.highlight = read_line_list(value),
            _ => read.lowlight = read_line_list(value),
        }
    }
    read
}

/// `info` with its language and its `name:` replaced, `None` removing one;
/// every other piece stays as written. A name not there yet goes after the
/// language, before the other keys; a repeated `name:` becomes one, where
/// its last spelling was. The caller checks that the result reads back.
pub(crate) fn write_fence_info(info: &str, language: Option<&str>, name: Option<&str>) -> String {
    let keys = fence_info_keys(info);
    let options_start = keys.first().map_or(info.len(), |(at, _)| *at);
    let mut written = written_language(&info[..options_start], language);
    let options: Vec<&str> = keys
        .iter()
        .enumerate()
        .map(|(index, (at, _))| {
            let end = keys.get(index + 1).map_or(info.len(), |(next, _)| *next);
            &info[*at..end]
        })
        .collect();
    let last_name = options
        .iter()
        .rposition(|option| option.starts_with("name:"));
    let mut rest = String::new();
    if let (None, Some(name)) = (last_name, name) {
        rest.push_str("name:");
        rest.push_str(name);
        if !options.is_empty() {
            rest.push(' ');
        }
    }
    for (index, option) in options.iter().enumerate() {
        if !option.starts_with("name:") {
            rest.push_str(option);
            continue;
        }
        if let (true, Some(name)) = (Some(index) == last_name, name) {
            rest.push_str("name:");
            rest.push_str(name);
            rest.push_str(&option[option.trim_end().len()..]);
        }
    }
    if !rest.is_empty() && !written.is_empty() && !written.ends_with(char::is_whitespace) {
        written.push(' ');
    }
    written.push_str(&rest);
    if !info.ends_with(char::is_whitespace) {
        written.truncate(written.trim_end().len());
    }
    written
}

/// What a code block's language field keeps of `typed`: the name field's
/// text (`typed_code_block_name`) as one word, its leading whitespace gone
/// and whitespace with text after it written `-`. Whitespace at its end
/// stays as one space, so typing `c`, space, `s` reads `c-s`; the header
/// write drops it.
pub fn typed_code_block_language(typed: &str) -> String {
    let name = typed_code_block_name(typed);
    let word = name.trim();
    let mut kept: String = word
        .chars()
        .map(|character| {
            if character.is_whitespace() {
                '-'
            } else {
                character
            }
        })
        .collect();
    if !word.is_empty() && name.ends_with(char::is_whitespace) {
        kept.push(' ');
    }
    kept
}

/// What a code block's name field keeps of `typed`: a backtick goes, as on
/// either fence kind (a backtick fence's info cannot hold one, and a block
/// reads the same whichever fence it has); a tab or line break becomes a
/// space and any other control character goes. Outer spaces stay, since
/// the field is typed a character at a time; the host trims the name it
/// writes.
pub fn typed_code_block_name(typed: &str) -> String {
    typed
        .chars()
        .filter(|character| {
            *character != '`' && (!character.is_control() || character.is_whitespace())
        })
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

/// The text before an info string's first key with its first word replaced
/// by `language`, or removed with the whitespace after it.
fn written_language(head: &str, language: Option<&str>) -> String {
    let Some(start) = head.find(|character: char| !character.is_whitespace()) else {
        return format!("{head}{}", language.unwrap_or(""));
    };
    let end = head[start..]
        .find(char::is_whitespace)
        .map_or(head.len(), |length| start + length);
    match language {
        Some(language) => format!("{}{language}{}", &head[..start], &head[end..]),
        None => format!("{}{}", &head[..start], head[end..].trim_start()),
    }
}

/// `3`, `2-4`, `9-7` (reversed reads as `7-9`), separated by commas. An item
/// that is not one of these, or reaches below line 1, is skipped.
fn read_line_list(value: &str) -> Vec<RangeInclusive<u64>> {
    value
        .split(',')
        .filter_map(|item| {
            let item = item.trim();
            let (first, second) = item.split_once('-').unwrap_or((item, item));
            let (first, second) = (line_number(first)?, line_number(second)?);
            let (from, to) = (first.min(second), first.max(second));
            (from >= 1).then_some(from..=to)
        })
        .collect()
}

/// ASCII digits as a number; one too large to be any line saturates.
fn line_number(digits: &str) -> Option<u64> {
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(digits.parse().unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(ranges: &[RangeInclusive<u64>]) -> Vec<u64> {
        ranges.iter().flat_map(|range| range.clone()).collect()
    }

    #[test]
    fn a_bare_language_and_an_empty_string() {
        let read = read_fence_info("Go");
        assert_eq!(read.language.as_deref(), Some("Go"));
        assert_eq!(read_fence_info(""), FenceInfo::default());
        assert_eq!(read_fence_info("   "), FenceInfo::default());
    }

    #[test]
    fn language_then_options_in_any_order() {
        let read = read_fence_info("go name:server.go hl:3-4 ll:6");
        assert_eq!(read.language.as_deref(), Some("go"));
        assert_eq!(read.name.as_deref(), Some("server.go"));
        assert_eq!(lines(&read.highlight), [3, 4]);
        assert_eq!(lines(&read.lowlight), [6]);
        let read = read_fence_info("rust ll:9 hl:1-2 name:main.rs");
        assert_eq!(read.name.as_deref(), Some("main.rs"));
        assert_eq!(lines(&read.highlight), [1, 2]);
        assert_eq!(lines(&read.lowlight), [9]);
    }

    #[test]
    fn a_name_keeps_spaces_until_the_next_key_at_a_word_start() {
        let read = read_fence_info("go name:api handlers.go hl:2");
        assert_eq!(read.name.as_deref(), Some("api handlers.go"));
        assert_eq!(lines(&read.highlight), [2]);
        assert_eq!(
            read_fence_info("go name:notes.hl:3.go").name.as_deref(),
            Some("notes.hl:3.go")
        );
    }

    #[test]
    fn the_language_is_one_word_before_the_first_key() {
        let read = read_fence_info("hl:2");
        assert_eq!(read.language, None);
        assert_eq!(lines(&read.highlight), [2]);
        assert_eq!(
            read_fence_info("c sharp hl:1").language.as_deref(),
            Some("c")
        );
        assert_eq!(
            read_fence_info("foo:bar").language.as_deref(),
            Some("foo:bar")
        );
        assert_eq!(
            read_fence_info("python extra").language.as_deref(),
            Some("python")
        );
        assert_eq!(read_fence_info("HL:2").language.as_deref(), Some("HL:2"));
    }

    #[test]
    fn a_repeated_key_keeps_its_last_value_and_an_empty_name_is_none() {
        assert_eq!(lines(&read_fence_info("go hl:1 hl:5").highlight), [5]);
        assert_eq!(read_fence_info("go name: hl:1").name, None);
    }

    #[test]
    fn line_lists() {
        assert_eq!(lines(&read_line_list("7-9,2")), [7, 8, 9, 2]);
        assert_eq!(lines(&read_line_list("9-7")), [7, 8, 9]);
        assert_eq!(lines(&read_line_list("1, 3")), [1, 3]);
        assert_eq!(lines(&read_line_list("0,abc,-1,4,0-2,3 - 4,1-2-3")), [4]);
        assert_eq!(
            read_line_list("2-99999999999999999999999").first(),
            Some(&(2..=u64::MAX))
        );
    }

    #[test]
    fn writing_keeps_every_other_piece() {
        let cases = [
            ("go hl:2 ll:4", Some("rust"), None, "rust hl:2 ll:4"),
            ("go hl:2", Some("go"), Some("a b.go"), "go name:a b.go hl:2"),
            ("hl:2", Some("go"), None, "go hl:2"),
            (
                "go  name:x  hl:2",
                Some("go"),
                Some("y"),
                "go  name:y  hl:2",
            ),
            ("go name:x hl:2", Some("go"), None, "go hl:2"),
            ("go hl:2 name:x", None, Some("x"), "hl:2 name:x"),
            ("go name:x", Some("go"), None, "go"),
            ("", None, Some("x"), "name:x"),
            ("", Some("go"), Some("x"), "go name:x"),
            (" go", None, None, ""),
            ("python extra", Some("go"), None, "go extra"),
            (
                "go name:a name:b hl:1",
                Some("go"),
                Some("c"),
                "go name:c hl:1",
            ),
            ("go ", Some("go"), Some("x"), "go name:x"),
        ];
        for (info, language, name, want) in cases {
            assert_eq!(write_fence_info(info, language, name), want, "{info:?}");
        }
    }

    #[test]
    fn a_line_in_both_lists_is_highlighted() {
        let read = read_fence_info("go hl:3-4 ll:4,8");
        assert_eq!(read.mark(3), Some(CodeLineMark::Highlight));
        assert_eq!(read.mark(4), Some(CodeLineMark::Highlight));
        assert_eq!(read.mark(8), Some(CodeLineMark::Lowlight));
        assert_eq!(read.mark(5), None);
        assert_eq!(read_fence_info("go hl:1-4000000000").mark(u32::MAX), None);
    }
}
