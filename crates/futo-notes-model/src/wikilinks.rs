//! Wikilink parsing: `[[target]]` and `[[target|alias]]`. Returns the link
//! TARGETS (the part before any `|`), trimmed, deduped, in first-seen order.
//! Targets are note ids/titles the UI resolves against the note index.

/// Extract wikilink targets from `content`. An empty target (`[[]]` or
/// `[[ |x]]`) is skipped. Matches the resolution the TS `wikilinks.ts` uses
/// (target = text before the first `|`, trimmed).
pub fn extract_wikilinks(content: &str) -> Vec<String> {
    let bytes = content.as_bytes();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut i = 0usize;
    let n = bytes.len();
    while i + 1 < n {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            // Find the closing ]]
            if let Some(close) = find_close(content, i + 2) {
                let inner = &content[i + 2..close];
                let target = inner.split('|').next().unwrap_or("").trim();
                if !target.is_empty() && seen.insert(target.to_string()) {
                    out.push(target.to_string());
                }
                i = close + 2;
                continue;
            }
        }
        // Advance by one full char to stay on UTF-8 boundaries.
        i += char_len(bytes[i]);
    }
    out
}

/// Byte index of the `]]` closing a wikilink opened at `from`, or `None`.
/// A `]]` cannot be preceded by another `[[` opening (no nesting).
fn find_close(content: &str, from: usize) -> Option<usize> {
    let bytes = content.as_bytes();
    let mut j = from;
    while j + 1 < bytes.len() {
        if bytes[j] == b']' && bytes[j + 1] == b']' {
            return Some(j);
        }
        // A new `[[` before a close means the first was unterminated.
        if bytes[j] == b'[' && bytes[j + 1] == b'[' {
            return None;
        }
        j += char_len(bytes[j]);
    }
    None
}

/// UTF-8 lead-byte → encoded length.
fn char_len(b: u8) -> usize {
    match b {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}
