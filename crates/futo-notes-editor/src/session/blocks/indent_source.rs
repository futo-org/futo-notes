//! Exact parser-owned container prefix spelling; never accepts body Markdown.
/// Only enclosing quote prefixes precede a list's indentation. Quote markers
/// inside the item are shifted with its body, never mistaken for its parent.
pub(super) fn quote_prefix_end(line: &str, depth: usize) -> usize {
    let mut at = 0;
    for _ in 0..depth {
        let spaces = line[at..].bytes().take_while(|&b| b == b' ').count().min(3);
        if line.as_bytes().get(at + spaces) != Some(&b'>') {
            break;
        }
        at += spaces + 1;
        if matches!(line.as_bytes().get(at), Some(b' ' | b'\t')) {
            at += 1;
        }
    }
    at
}

pub(super) fn shift_prefix(prefix: &str, quote: usize, delta: isize, preserve: bool) -> String {
    if preserve || delta == 0 {
        return prefix.to_owned();
    }
    let end = quote_prefix_end(prefix, quote);
    let base = crate::inline::columns(&prefix[..end], 0);
    let mut result = prefix[..end].to_owned();
    let tail = &prefix[end..];
    if delta > 0 {
        result.push_str(&" ".repeat(delta as usize));
        result.push_str(tail);
    } else {
        let width = delta.unsigned_abs();
        let mut column = base;
        let mut bytes = 0;
        for byte in tail.bytes() {
            if column - base >= width || !matches!(byte, b' ' | b'\t') {
                break;
            }
            column = crate::inline::columns(&tail[bytes..bytes + 1], column);
            bytes += 1;
        }
        result.push_str(&" ".repeat((column - base).saturating_sub(width)));
        result.push_str(&tail[bytes..]);
    }
    result
}
