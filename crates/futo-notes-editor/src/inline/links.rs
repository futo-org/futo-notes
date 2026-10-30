//! Link source boundaries are owned here; destination interpretation comes from
//! the Markdown parser. Consumers receive destination semantics, never syntax.
use std::ops::Range;

pub(super) fn label_range(source: &str, whole: Range<usize>) -> Range<usize> {
    let raw = &source[whole.clone()];
    if raw.starts_with('<') {
        return whole.start + 1..whole.end - 1;
    }
    // A parsed link's label ends at the matching unescaped bracket. Nested
    // brackets belong to its label, including formatting/code inside it.
    let mut depth = 0;
    let mut escaped = false;
    for (at, ch) in raw.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '[' {
            depth += 1;
        }
        if ch == ']' {
            depth -= 1;
            if depth == 0 {
                return whole.start + 1..whole.start + at;
            }
        }
    }
    whole
}
