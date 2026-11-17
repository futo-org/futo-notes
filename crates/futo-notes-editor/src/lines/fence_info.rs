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

/// Read the text after an opening fence's backticks or tildes. A key opens an
/// option only at the start or after whitespace, so a value may hold spaces
/// (`name:api handlers.go`) and `notes.hl:3.go` stays one value. A repeated
/// key keeps its last value.
pub(crate) fn read_fence_info(info: &str) -> FenceInfo {
    let mut keys: Vec<(usize, &str)> = Vec::new();
    let mut at_boundary = true;
    for (at, character) in info.char_indices() {
        if at_boundary {
            if let Some(key) = FENCE_INFO_KEYS
                .iter()
                .find(|key| info[at..].starts_with(*key))
            {
                keys.push((at, key));
            }
        }
        at_boundary = character.is_whitespace();
    }
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
    fn a_line_in_both_lists_is_highlighted() {
        let read = read_fence_info("go hl:3-4 ll:4,8");
        assert_eq!(read.mark(3), Some(CodeLineMark::Highlight));
        assert_eq!(read.mark(4), Some(CodeLineMark::Highlight));
        assert_eq!(read.mark(8), Some(CodeLineMark::Lowlight));
        assert_eq!(read.mark(5), None);
        assert_eq!(read_fence_info("go hl:1-4000000000").mark(u32::MAX), None);
    }
}
