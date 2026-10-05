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

fn backtick_run_end(bytes: &[u8], start: usize) -> usize {
    let mut end = start;
    while end < bytes.len() && bytes[end] == b'`' {
        end += 1;
    }
    end
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

/// Byte ranges treated as blanked: fenced code, then inline code outside the
/// fences, the same order as TS `stripCodeRegions`.
fn code_regions(content: &str, bytes: &[u8]) -> Vec<(usize, usize)> {
    if memchr::memchr2(b'`', b'~', bytes).is_none() {
        return Vec::new();
    }
    let mut regions = fenced_regions(content, bytes);
    regions.sort_unstable_by_key(|&(start, _)| start);
    merge_regions(&mut regions);

    let inline = inline_code_regions(bytes, &regions);
    if inline.is_empty() {
        return regions;
    }
    regions.extend(inline);
    regions.sort_unstable_by_key(|&(start, _)| start);
    merge_regions(&mut regions);
    regions
}

fn merge_regions(regions: &mut Vec<(usize, usize)>) {
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(regions.len());
    for &(start, end) in regions.iter() {
        match merged.last_mut() {
            Some(last) if start <= last.1 => {
                if end > last.1 {
                    last.1 = end;
                }
            }
            _ => merged.push((start, end)),
        }
    }
    *regions = merged;
}

/// One fence-marker line, matching what `(?m)^( {0,3})(`{3,}|~{3,})(.*)$`
/// captures: `index` is the line's start, `end_of_line` is the position right
/// after the line's content (before its trailing `\n`, if any).
struct FenceLine {
    index: usize,
    end_of_line: usize,
    marker_char: u8,
    marker_len: usize,
    rest_blank: bool,
}

/// That regex as a byte scan (pinned by `fence_scan_matches_the_fence_regex`).
/// The fence marker on the line `line_start..line_end`, if it has one.
fn fence_at(content: &str, bytes: &[u8], line_start: usize, line_end: usize) -> Option<FenceLine> {
    let max_indent = (line_start + 3).min(line_end);
    let mut marker_start = line_start;
    while marker_start < max_indent && bytes[marker_start] == b' ' {
        marker_start += 1;
    }
    let marker_char = *bytes
        .get(marker_start)
        .filter(|_| marker_start < line_end)?;
    if marker_char != b'`' && marker_char != b'~' {
        return None;
    }
    let mut marker_end = marker_start;
    while marker_end < line_end && bytes[marker_end] == marker_char {
        marker_end += 1;
    }
    (marker_end - marker_start >= 3).then(|| FenceLine {
        index: line_start,
        end_of_line: line_end,
        marker_char,
        marker_len: marker_end - marker_start,
        rest_blank: content[marker_end..line_end].trim().is_empty(),
    })
}

fn scan_fence_lines(content: &str, bytes: &[u8]) -> Vec<FenceLine> {
    let len = bytes.len();
    let mut out = Vec::new();
    let mut line_start = 0usize;
    loop {
        let line_end = memchr::memchr(b'\n', &bytes[line_start..])
            .map(|pos| line_start + pos)
            .unwrap_or(len);

        out.extend(fence_at(content, bytes, line_start, line_end));
        if line_end == len {
            break;
        }
        line_start = line_end + 1;
    }
    out
}

/// A fence line closes the most recently opened fence when the marker char
/// matches, the run is at least as long and the rest of the line is blank;
/// otherwise it opens one. A fence left open runs to the end.
fn fenced_regions(content: &str, bytes: &[u8]) -> Vec<(usize, usize)> {
    let fence_lines = scan_fence_lines(content, bytes);

    struct OpenFence {
        pos: usize,
        marker_char: u8,
        marker_len: usize,
    }
    let mut open_fences: Vec<OpenFence> = Vec::new();
    let mut regions: Vec<(usize, usize)> = Vec::new();
    for f in &fence_lines {
        if let Some(open) = open_fences.last() {
            if f.marker_char == open.marker_char && f.marker_len >= open.marker_len && f.rest_blank
            {
                regions.push((open.pos, f.end_of_line));
                open_fences.pop();
                continue;
            }
        }
        open_fences.push(OpenFence {
            pos: f.index,
            marker_char: f.marker_char,
            marker_len: f.marker_len,
        });
    }
    for open in &open_fences {
        regions.push((open.pos, content.len()));
    }
    regions
}

/// The non-overlapping matches of ``(`+)([^`]*?)\1`` in linear time, with
/// fenced bytes treated as absent (pinned by
/// `linear_inline_scan_matches_backreference_regex`).
fn inline_code_regions(bytes: &[u8], fenced: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut matches = Vec::new();
    let skipper = RegionCursor::new(fenced);
    let mut cursor = 0usize;
    while let Some(start) = next_backtick_outside(bytes, cursor, &skipper) {
        let opener_end = backtick_run_end(bytes, start);
        let opener_len = opener_end - start;
        let next_start = next_backtick_outside(bytes, opener_end, &skipper);

        let match_end = next_start.and_then(|closing_start| {
            let closing_len = backtick_run_end(bytes, closing_start) - closing_start;
            (closing_len >= opener_len).then_some(closing_start + opener_len)
        });

        if let Some(end) = match_end {
            matches.push((start, end));
            cursor = end;
        } else if opener_len >= 2 {
            let end = start + 2 * (opener_len / 2);
            matches.push((start, end));
            cursor = end;
        } else {
            cursor = opener_end;
        }
    }
    matches
}

/// The next backtick at or after `from` outside a fenced region.
fn next_backtick_outside(bytes: &[u8], from: usize, skipper: &RegionCursor) -> Option<usize> {
    let mut pos = from;
    loop {
        pos = skipper.skip(pos);
        let found = pos + memchr::memchr(b'`', &bytes[pos..])?;
        let after = skipper.skip(found);
        if after == found {
            return Some(found);
        }
        pos = after;
    }
}

/// Point queries against sorted, disjoint ranges. Binary search, not a
/// forward-only pointer: a failed closing-backtick probe resumes from an
/// earlier position, so queries are not monotonic.
struct RegionCursor<'a> {
    regions: &'a [(usize, usize)],
}

impl<'a> RegionCursor<'a> {
    fn new(regions: &'a [(usize, usize)]) -> Self {
        Self { regions }
    }

    /// True if `pos` lies inside some region (`start <= pos < end`).
    fn covers(&self, pos: usize) -> bool {
        match self.regions.binary_search_by(|&(start, _)| start.cmp(&pos)) {
            Ok(_) => true,
            Err(idx) => idx > 0 && self.regions[idx - 1].1 > pos,
        }
    }

    /// True if some region ends exactly at `pos` (equivalently, `pos - 1` is
    /// covered by that region) — used instead of a separate `covers(pos - 1)`
    /// query.
    fn immediately_after_region(&self, pos: usize) -> bool {
        self.regions
            .binary_search_by(|&(_, end)| end.cmp(&pos))
            .is_ok()
    }

    /// If `pos` lies inside a region, returns that region's end (the first
    /// position outside it); otherwise returns `pos` unchanged.
    fn skip(&self, pos: usize) -> usize {
        match self.regions.binary_search_by(|&(start, _)| start.cmp(&pos)) {
            Ok(idx) => self.regions[idx].1,
            Err(idx) if idx > 0 && self.regions[idx - 1].1 > pos => self.regions[idx - 1].1,
            Err(_) => pos,
        }
    }
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
mod tag_scan_tests {
    use super::*;
    use std::time::Instant;

    fn names(s: &str) -> Vec<String> {
        tag_regex_matches(s)
    }

    #[test]
    fn matches_basic_and_adjacent() {
        assert_eq!(names("#hello"), vec!["hello"]);
        // start-of-string and after-whitespace; adjacency must both match (the
        // boundaries are zero-width, so the shared space isn't consumed).
        assert_eq!(names("#a #b"), vec!["a", "b"]);
        // start-of-line via (?m)^ (subsumed by "preceded by \n").
        assert_eq!(names("x\n#tag"), vec!["tag"]);
        // not preceded by whitespace ⇒ no match.
        assert!(names("word#tag").is_empty());
        assert!(names("##tag").is_empty());
    }

    #[test]
    fn terminators_and_punctuation() {
        // Right-boundary terminators. Each `#` has a valid LEFT boundary (a
        // leading space) so we isolate the terminator behavior.
        for (input, want) in [
            ("#tag.", "tag"),
            ("#tag,", "tag"),
            (" #tag)", "tag"),
            ("#tag!", "tag"),
            ("#tag?", "tag"),
            ("#tag]", "tag"),
            ("#tag}", "tag"),
        ] {
            assert_eq!(names(input), vec![want], "input={input:?}");
        }
        // The `#` must follow whitespace or line-start: `(#tag)` has `#` after
        // `(`, so per `(?:^|(?<=\s))` it does NOT match (matches the TS rule).
        assert!(names("(#tag)").is_empty());
        // a non-terminator, non-name char right after the name ⇒ no match
        // (the look-ahead fails and no shorter name is valid).
        assert!(names("#tag@x").is_empty());
        assert!(names("#tag/x").is_empty());
        // hyphen/underscore/digits are name chars.
        assert_eq!(names("#a-b_c1 "), vec!["a-b_c1"]);
    }

    #[test]
    fn length_cap_50() {
        let n50: String = format!("#{}", "a".repeat(50));
        assert_eq!(names(&n50), vec!["a".repeat(50)]);
        // 51 name chars: greedy matches 50, char #51 is a name char (not a
        // terminator) ⇒ look-ahead fails for every length ⇒ no match.
        let n51: String = format!("#{} ", "a".repeat(51));
        assert!(names(&n51).is_empty(), "51-char run must not match");
    }

    #[test]
    fn first_char_must_be_letter() {
        assert!(names("#1tag").is_empty());
        assert!(names("#-tag").is_empty());
        assert!(names("#_tag").is_empty());
    }

    #[test]
    fn unicode_whitespace_boundary() {
        // U+00A0 NBSP is Unicode White_Space, so it satisfies both (?<=\s)
        // (left) and the look-ahead (right).
        assert_eq!(names("a\u{00a0}#tag\u{00a0}b"), vec!["tag"]);
    }

    // Regression for the catastrophic-backtracking hang: a ~1 MB note must
    // extract in well under a second. The old fancy-regex `captures_iter`
    // pegged a core for MINUTES on the real ~900 KB note, which left the
    // off-main iOS note scan permanently incomplete (list stuck empty).
    #[test]
    fn large_note_extracts_fast_and_correct() {
        // Markdown-ish block: headers, prose with `#`, punctuation, and one
        // real tag — the kind of content that triggered the blow-up.
        let block = "### A Heading With Words\n\nSome prose, with punctuation; \
            and the #realtag here. More text: see section #3 and item #b? Yes.\n\n";
        let big = block.repeat(10_000); // ~1.2 MB (larger than the real culprit)
        assert!(big.len() > 1_000_000);

        let t = Instant::now();
        let tags = extract_tags(&big);
        let elapsed = t.elapsed();

        assert!(
            tags.contains(&"#realtag".to_string()),
            "should still find the real tag"
        );
        // `#3` (digit-led) and `#b?` are valid/invalid per the rules; the point
        // is it COMPLETES. Linear scan ⇒ a few ms; the old code ⇒ minutes.
        assert!(
            elapsed.as_secs() < 3,
            "tag extraction on a ~1 MB note must be fast (was {elapsed:?}); \
             a regression here means catastrophic backtracking is back"
        );
    }

    // Regression for the second catastrophic-backtracking path: stripping
    // inline code from a large mixed-markdown note. The obstacle-course
    // monster contains thousands of backtick runs; the backreference-based
    // fancy-regex implementation never returned once the note reached ~1 MB.
    #[test]
    fn large_backtick_note_extracts_fast_and_correct() {
        let prose = "Ordinary prose with enough varied words and #outside content \
            to model a real long note rather than a blank buffer.\n\n"
            .repeat(20_000);
        let big = format!("{prose}```rust\nlet hidden = \"#inside\";\n```\n");
        assert!(big.len() > 1_000_000);

        let t = Instant::now();
        let tags = extract_tags(&big);
        let elapsed = t.elapsed();

        assert_eq!(tags, vec!["#outside"]);
        assert!(
            elapsed.as_secs() < 3,
            "code-region stripping on a ~1 MB backtick note must be fast \
             (was {elapsed:?})"
        );
    }

    #[test]
    fn fence_scan_matches_the_fence_regex() {
        let fence = Regex::new(r"(?m)^( {0,3})(`{3,}|~{3,})(.*)$").unwrap();
        let alphabet = ['`', '~', ' ', '\n', 'a'];
        for len in 0usize..=7 {
            for mut encoded in 0..alphabet.len().pow(len as u32) {
                let mut input = String::with_capacity(len);
                for _ in 0..len {
                    input.push(alphabet[encoded % alphabet.len()]);
                    encoded /= alphabet.len();
                }
                let expected: Vec<_> = fence
                    .captures_iter(&input)
                    .flatten()
                    .map(|caps| {
                        let whole = caps.get(0).unwrap();
                        (
                            whole.start(),
                            whole.end(),
                            caps[2].as_bytes()[0],
                            caps[2].len(),
                            caps[3].trim().is_empty(),
                        )
                    })
                    .collect();
                let actual: Vec<_> = scan_fence_lines(&input, input.as_bytes())
                    .iter()
                    .map(|line| {
                        (
                            line.index,
                            line.end_of_line,
                            line.marker_char,
                            line.marker_len,
                            line.rest_blank,
                        )
                    })
                    .collect();
                assert_eq!(actual, expected, "input={input:?}");
            }
        }
    }

    #[test]
    fn linear_inline_scan_matches_backreference_regex() {
        let old = Regex::new(r"(`+)([^`]*?)\1").unwrap();
        let alphabet = ['`', 'a', '\n', 'é'];

        for len in 0usize..=8 {
            let cases = alphabet.len().pow(len as u32);
            for mut encoded in 0..cases {
                let mut input = String::with_capacity(len);
                for _ in 0..len {
                    input.push(alphabet[encoded % alphabet.len()]);
                    encoded /= alphabet.len();
                }

                let expected: Vec<(usize, usize)> = old
                    .find_iter(&input)
                    .flatten()
                    .map(|matched| (matched.start(), matched.end()))
                    .collect();
                assert_eq!(
                    inline_code_regions(input.as_bytes(), &[]),
                    expected,
                    "input={input:?}"
                );
            }
        }
    }
}
