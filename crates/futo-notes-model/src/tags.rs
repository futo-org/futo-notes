//! Tag parsing + validation. Ported bit-for-bit from
//! `packages/shared/src/tags.ts`.
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

use std::borrow::Cow;
use std::sync::OnceLock;

use fancy_regex::Regex;

/// Maximum length of a tag name (after the `#`). Matches TS `MAX_TAG_LENGTH`.
pub const MAX_TAG_LENGTH: usize = 50;

/// `TAG_REGEX` equivalent: start-of-line or after whitespace, `#`, a name
/// starting with a letter, terminated by end-of-line / whitespace / one of a
/// small punctuation set. `(?m)` makes `^`/`$` line-anchored like the JS `m`
/// flag.
fn tag_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)(?:^|(?<=\s))#([a-zA-Z][a-zA-Z0-9_-]{0,49})(?=$|\s|[.,;:!?)}\]])")
            .expect("TAG_REGEX must compile")
    })
}

/// A line consisting only of tags and whitespace. Matches TS `TAG_LINE_RE`.
fn tag_line_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^\s*#[a-zA-Z][a-zA-Z0-9_-]{0,49}(\s+#[a-zA-Z][a-zA-Z0-9_-]{0,49})*\s*$")
            .expect("TAG_LINE_RE must compile")
    })
}

/// Matches a run of N backticks, the minimal non-backtick span, then the same
/// run of N backticks (backreference → fancy-regex). Inline code.
fn inline_code_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(`+)([^`]*?)\1").expect("inline-code regex must compile"))
}

/// A fence line: ≤3 leading spaces, then a run of ``` or ~~~, then the rest of
/// the line. `(?m)` so `^`/`$` are line-anchored.
fn fence_line_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^( {0,3})(`{3,}|~{3,})(.*)$").expect("fence regex must compile"))
}

/// Raw `TAG_REGEX` capture-group-1 values in document order (with whatever
/// duplicates the regex itself yields — `extract_tags` dedups afterward).
/// Exposed for conformance; also the per-line scan used internally.
pub fn tag_regex_matches(content: &str) -> Vec<String> {
    let re = tag_regex();
    let mut out = Vec::new();
    for caps in re.captures_iter(content).flatten() {
        if let Some(m) = caps.get(1) {
            out.push(m.as_str().to_string());
        }
    }
    out
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

/// Blank out regions inside fenced code blocks (``` / ~~~) and inline code
/// (backticks), replacing them with spaces while preserving newlines and byte
/// offsets. Port of TS `stripCodeRegions`.
///
/// Returns `Cow::Borrowed` unchanged when the note contains no backtick at all
/// (no fences, no inline code) — the overwhelmingly common case for prose
/// notes. That fast path skips the two full-body copies (`bytes.to_vec()` +
/// the inline-pass result string) the general algorithm needs, which on a
/// multi-MB note is the difference between two megabyte allocations per scan
/// and none. The slow path below is byte-for-byte unchanged.
fn strip_code_regions(content: &str) -> Cow<'_, str> {
    // A code region can only exist if there is a backtick (inline code, and the
    // only fence markers that can interact with the TAG_REGEX terminator set).
    // `~~~` fences contain no tag-eligible `#...` differently than a plain line
    // would, but the reference still blanks them — so we must NOT short-circuit
    // on `~`-only content. We short-circuit only when there is no backtick AND
    // no tilde-fence marker.
    if !content.contains('`') && !content.contains('~') {
        return Cow::Borrowed(content);
    }
    Cow::Owned(strip_code_regions_full(content))
}

/// The full (allocating) `stripCodeRegions` port. Always correct; the public
/// `strip_code_regions` only calls this when a code marker is actually present.
fn strip_code_regions_full(content: &str) -> String {
    let bytes = content.as_bytes();
    let mut buf = bytes.to_vec();

    // ── Pass 1: fenced blocks ──
    #[derive(Clone)]
    struct FenceLine {
        index: usize,
        end_of_line: usize, // byte offset of the char after the line's content
        marker_char: u8,
        marker_len: usize,
        rest_blank: bool,
    }
    let mut fence_lines: Vec<FenceLine> = Vec::new();
    for caps in fence_line_regex().captures_iter(content).flatten() {
        let whole = caps.get(0).unwrap();
        let indent = caps.get(1).unwrap();
        let marker = caps.get(2).unwrap();
        let rest = caps.get(3).unwrap();
        fence_lines.push(FenceLine {
            index: indent.start(),
            // = fence.index + marker.len + indent.len + rest.len (TS), i.e. the
            // end of the line content (exclusive of the trailing newline).
            end_of_line: whole.end(),
            marker_char: marker.as_str().as_bytes()[0],
            marker_len: marker.as_str().len(),
            rest_blank: rest.as_str().trim().is_empty(),
        });
    }

    struct OpenFence {
        pos: usize,
        marker_char: u8,
        marker_len: usize,
    }
    let mut open_fences: Vec<OpenFence> = Vec::new();
    let mut regions: Vec<(usize, usize)> = Vec::new();
    for f in &fence_lines {
        if let Some(open) = open_fences.last() {
            // Closing fence: same char, at least as long, rest blank.
            if f.marker_char == open.marker_char && f.marker_len >= open.marker_len && f.rest_blank {
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
    // Unclosed fences extend to end of document.
    for open in &open_fences {
        regions.push((open.pos, content.len()));
    }

    for (start, end) in regions {
        let end = end.min(buf.len());
        for b in buf.iter_mut().take(end).skip(start) {
            if *b != b'\n' {
                *b = b' ';
            }
        }
    }

    // `buf` only had non-newline bytes overwritten by spaces within
    // char-aligned ranges, so it is still valid UTF-8.
    let pass1 = String::from_utf8(buf).expect("strip pass1 stays valid UTF-8");

    // ── Pass 2: inline code (backtick runs) ──
    let re = inline_code_regex();
    let mut result = String::with_capacity(pass1.len());
    let mut last = 0usize;
    for m in re.find_iter(&pass1).flatten() {
        result.push_str(&pass1[last..m.start()]);
        for c in pass1[m.start()..m.end()].chars() {
            result.push(if c == '\n' { '\n' } else { ' ' });
        }
        last = m.end();
    }
    result.push_str(&pass1[last..]);
    result
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
/// (the list/search display form) needs, so the scan path uses it directly
/// instead of building `#tag` strings only to strip the `#` back off per note.
pub fn extract_tag_names(content: &str) -> Vec<String> {
    let cleaned = strip_code_regions(content);
    let mut seen = std::collections::HashSet::new();
    let mut names = Vec::new();
    for raw in tag_regex_matches(&cleaned) {
        let name = normalize_tag_name(&raw);
        if seen.insert(name.clone()) {
            names.push(name);
        }
    }
    names
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
