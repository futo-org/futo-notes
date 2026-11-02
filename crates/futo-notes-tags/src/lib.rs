//! Tag parsing + validation. Ported bit-for-bit from
//! `packages/editor/src/tags.ts`.
//!
//! Tag syntax: `#[a-z][a-z0-9_-]*` (≤ 50 chars after `#`), must follow
//! whitespace or start-of-line, must not sit inside a code fence or inline
//! code. The TS `TAG_REGEX` uses a lookbehind + lookahead, which the `regex`
//! crate cannot express, so this module uses `fancy-regex`.
//!
//! Offsets: `extract_header_tag_block` returns a **byte** offset (Rust UTF-8),
//! whereas the TS reference returns a UTF-16 code-unit offset. They agree for
//! ASCII (which every conformance fixture is); for non-ASCII the offset is
//! representation-correct on each side and callers slice their own string.

use std::sync::OnceLock;

use fancy_regex::Regex;

mod code_regions;
use code_regions::{code_regions, RegionCursor};

/// Maximum length of a tag name (after the `#`). Matches TS `MAX_TAG_LENGTH`.
pub const MAX_TAG_LENGTH: usize = 50;

/// A line consisting only of tags and whitespace. Matches TS `TAG_LINE_RE`.
fn tag_line_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^\s*#[a-zA-Z][a-zA-Z0-9_-]{0,49}(\s+#[a-zA-Z][a-zA-Z0-9_-]{0,49})*\s*$")
            .expect("TAG_LINE_RE must compile")
    })
}

/// Raw `TAG_REGEX` capture-group-1 values (tag names without `#`) in document
/// order, with whatever duplicates the pattern yields (`extract_tags` dedups
/// afterward). Exposed for conformance; also the per-line scan used internally.
///
/// LINEAR hand-scan, NOT a regex. It replaces the previous `fancy-regex`
/// pattern `(?m)(?:^|(?<=\s))#([a-zA-Z][a-zA-Z0-9_-]{0,49})(?=$|\s|[.,;:!?)}\]])`,
/// which — run through fancy-regex's backtracking VM via `captures_iter` —
/// was pathologically slow on large notes (a ~900 KB note pegged a core for
/// minutes), so the off-main note scan never finished and the list stayed
/// empty. This scan visits each byte O(1).
///
/// It is byte-for-byte equivalent to the pattern (locked by the
/// `tagRegexMatches` conformance fixtures) because the pattern admits NO
/// genuine backtracking: the name class `[a-zA-Z0-9_-]` is disjoint from the
/// terminator set (`\s` and `[.,;:!?)}\]]`), so the greedy `{0,49}` can only
/// satisfy the look-ahead at the natural end of the name run — a shorter name
/// is never valid when the maximal one isn't, and a run longer than 50 name
/// chars can never match (the char after any ≤50 prefix is itself a name
/// char, never a terminator). A match requires, at a `#`:
///   1. left boundary `(?:^|(?<=\s))`: start-of-string, or the preceding char
///      is `\s` (`(?m)^` after a newline is subsumed — `\n` is `\s`);
///   2. a name `[a-zA-Z][a-zA-Z0-9_-]{0,49}` (1..=50 chars);
///   3. right boundary `(?=$|\s|[.,;:!?)}\]])` (zero-width — not consumed).
/// `\s` is Unicode White_Space (`char::is_whitespace()`), which is what the
/// `regex`/`fancy-regex` `\s` resolved to.
pub fn tag_regex_matches(content: &str) -> Vec<String> {
    let bytes = content.as_bytes();
    let n = bytes.len();
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        if bytes[i] != b'#' {
            i += 1;
            continue;
        }
        // (1) left boundary: start-of-string, or preceded by a whitespace char.
        if !(i == 0 || prev_char_is_whitespace(content, i)) {
            i += 1;
            continue;
        }
        // (2) name: first char [a-zA-Z], then up to 49 of [a-zA-Z0-9_-].
        let name_start = i + 1;
        if name_start >= n || !bytes[name_start].is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        let mut j = name_start + 1;
        while j < n && is_tag_name_byte(bytes[j]) {
            j += 1;
        }
        // (3) length 1..=50 AND right boundary is EOS / \s / terminator punct.
        if (j - name_start) <= MAX_TAG_LENGTH && tag_right_boundary_ok(content, j) {
            // Names are ASCII, so `content[name_start..j]` is a valid str slice.
            out.push(content[name_start..j].to_string());
        }
        // No `#` lives inside a name run and the `#` at `i` is handled, so
        // resuming at `j` (the first non-name byte, always > `i`) skips no
        // candidate. On a match this is exactly where `captures_iter` would
        // resume — the zero-width look-ahead is not consumed.
        i = j;
    }
    out
}

/// True if the char ending immediately before byte index `i` is Unicode
/// whitespace — the `\s` in the tag pattern's `(?<=\s)`. `i` points at an
/// ASCII `#`, so it is a char boundary; we step back over any UTF-8
/// continuation bytes to the start of the preceding char. Caller guarantees
/// `i >= 1`.
fn prev_char_is_whitespace(s: &str, i: usize) -> bool {
    let bytes = s.as_bytes();
    let mut k = i - 1;
    while k > 0 && (bytes[k] & 0xC0) == 0x80 {
        k -= 1;
    }
    s[k..i].chars().next().is_some_and(char::is_whitespace)
}

/// A `[a-zA-Z0-9_-]` byte (a tag-name continuation char).
fn is_tag_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// The tag terminator look-ahead `(?=$|\s|[.,;:!?)}\]])` evaluated at byte
/// index `j` (a char boundary — the bytes before it are ASCII name chars).
fn tag_right_boundary_ok(s: &str, j: usize) -> bool {
    match s[j..].chars().next() {
        None => true, // end-of-string ($)
        Some(c) => {
            c.is_whitespace() || matches!(c, '.' | ',' | ';' | ':' | '!' | '?' | ')' | '}' | ']')
        }
    }
}

/// True if `name` (without `#`) is a valid tag name. Matches TS
/// `isValidTagName`: 1..=50 chars, `^[a-z][a-z0-9_-]*$`.
pub fn is_valid_tag_name(name: &str) -> bool {
    let len = name.chars().count();
    if len == 0 || len > MAX_TAG_LENGTH {
        return false;
    }
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Normalize user-entered tag text to the canonical on-disk name. Matches TS
/// `normalizeTagName`: trim, strip leading `#`s, trim, lowercase, collapse
/// whitespace runs to a single `_`.
pub fn normalize_tag_name(name: &str) -> String {
    let stripped = name.trim().trim_start_matches('#').trim().to_lowercase();
    let mut out = String::with_capacity(stripped.len());
    let mut in_ws = false;
    for c in stripped.chars() {
        if c.is_whitespace() {
            if !in_ws {
                out.push('_');
                in_ws = true;
            }
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

/// Extract all unique tags from note content, excluding tags inside code
/// blocks/fences. Returns canonical tags WITH the `#` prefix, in first-seen
/// order. Matches TS `extractTags`.
pub fn extract_tags(content: &str) -> Vec<String> {
    extract_tag_names(content)
        .into_iter()
        .map(|name| {
            let mut tag = String::with_capacity(name.len() + 1);
            tag.push('#');
            tag.push_str(&name);
            tag
        })
        .collect()
}

/// Same rule as [`extract_tags`] but returns the canonical tag names WITHOUT
/// the leading `#`, in first-seen order. This is the form `NoteMetadata.tags`
/// (the list/search display form) needs.
///
/// One pass over the original text rather than over a copy with code blanked
/// to spaces (as `packages/editor/src/tags.ts` does): a `#` inside a code
/// region is skipped, and a position inside one counts as whitespace for the
/// boundary checks, which is what the blanked copy would have held there. A
/// name can never run into a region, since a fence starts after `\n` and
/// inline code at a backtick.
pub fn extract_tag_names(content: &str) -> Vec<String> {
    let bytes = content.as_bytes();
    let regions = code_regions(content, bytes);
    let cursor = RegionCursor::new(&regions);

    let mut seen = std::collections::HashSet::new();
    let mut names = Vec::new();
    let mut i = 0usize;
    while let Some(offset) = memchr::memchr(b'#', &bytes[i..]) {
        let (tag, next) = tag_at(content, &cursor, i + offset);
        if let Some(range) = tag {
            let name = normalize_tag_name(&content[range]);
            if seen.insert(name.clone()) {
                names.push(name);
            }
        }
        i = next;
    }
    names
}

/// The tag name after the `#` at `hash`, if one starts there, and where the
/// scan resumes. A position inside a code region counts as whitespace on
/// either side, as the blanked copy would.
fn tag_at(
    content: &str,
    cursor: &RegionCursor,
    hash: usize,
) -> (Option<std::ops::Range<usize>>, usize) {
    let bytes = content.as_bytes();
    let left_ok = !cursor.covers(hash)
        && (hash == 0
            || cursor.immediately_after_region(hash)
            || prev_char_is_whitespace(content, hash));
    let name_start = hash + 1;
    if !left_ok || !bytes.get(name_start).is_some_and(u8::is_ascii_alphabetic) {
        return (None, hash + 1);
    }
    let mut end = name_start + 1;
    while end < bytes.len() && is_tag_name_byte(bytes[end]) {
        end += 1;
    }
    let right_ok = end - name_start <= MAX_TAG_LENGTH
        && (cursor.covers(end) || tag_right_boundary_ok(content, end));
    (right_ok.then_some(name_start..end), end)
}

/// Result of `extract_header_tag_block`: the canonical tags and the byte
/// offset where the header block ends (including any trailing blank-line
/// separator).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderTagBlock {
    pub tags: Vec<String>,
    pub end_offset: usize,
}

/// Extract the contiguous run of tag-only lines at the very start of the note.
/// Matches TS `extractHeaderTagBlock` (offset in bytes; see module note).
pub fn extract_header_tag_block(content: &str) -> HeaderTagBlock {
    let bytes = content.as_bytes();
    let len = content.len();
    let mut tags = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut offset = 0usize;
    let mut cursor = 0usize;
    let line_re = tag_line_regex();

    while cursor <= len {
        // indexOf('\n', cursor)
        let nl_idx = content[cursor..].find('\n').map(|i| cursor + i);
        let line_end = nl_idx.unwrap_or(len);
        let line = &content[cursor..line_end];
        if !line_re.is_match(line).unwrap_or(false) {
            break;
        }
        for name in tag_regex_matches(line) {
            let tag = format!("#{}", normalize_tag_name(&name));
            if seen.insert(tag.clone()) {
                tags.push(tag);
            }
        }
        offset = match nl_idx {
            Some(i) => i + 1,
            None => len,
        };
        match nl_idx {
            None => break,
            Some(_) => cursor = offset,
        }
    }

    if offset == 0 {
        return HeaderTagBlock {
            tags: Vec::new(),
            end_offset: 0,
        };
    }

    // Include a trailing blank line if present (the block is terminated by an
    // empty-line separator, not by a content line).
    if offset < len {
        let next_nl = content[offset..].find('\n').map(|i| offset + i);
        let trail_end = next_nl.unwrap_or(len);
        let only_blank = bytes[offset..trail_end]
            .iter()
            .all(|&b| b == 0x20 || b == 0x09 || b == 0x0d);
        if only_blank {
            offset = match next_nl {
                Some(i) => i + 1,
                None => len,
            };
        }
    }

    if offset > len {
        offset = len;
    }
    HeaderTagBlock {
        tags,
        end_offset: offset,
    }
}

#[cfg(test)]
mod tag_scan_tests;
