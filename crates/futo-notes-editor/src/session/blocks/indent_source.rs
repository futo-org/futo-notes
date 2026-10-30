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

/// Spell all changed container columns in one pass over a physical prefix.
/// Canonical attribution supplies quote count and width deltas; body bytes are
/// never accepted here. Keep authored tabs when they still land at the target.
pub(super) fn shift_prefixes(
    prefix: &str,
    quote_depth: usize,
    shifts: &std::collections::BTreeMap<usize, isize>,
    preserve: bool,
) -> Result<String, super::EditorError> {
    if preserve {
        return Ok(prefix.to_owned());
    }
    let mut result = String::with_capacity(prefix.len());
    let mut at = 0;
    let mut depth = 0;
    let mut old_column = 0usize;
    let mut new_column = 0usize;
    let mut delta = shifts.get(&0).copied().unwrap_or(0);
    loop {
        let start = at;
        while matches!(prefix.as_bytes().get(at), Some(b' ' | b'\t')) {
            crate::inline::visit_container();
            at += 1;
        }
        let whitespace = &prefix[start..at];
        old_column = crate::inline::columns(whitespace, old_column);
        let target = old_column
            .checked_add_signed(delta)
            .filter(|&target| target >= new_column)
            .ok_or(super::EditorError::UnrepresentableFormat)?;
        if crate::inline::columns(whitespace, new_column) == target {
            result.push_str(whitespace);
        } else {
            result.extend(std::iter::repeat(' ').take(target - new_column));
        }
        new_column = target;
        let Some(ch) = prefix[at..].chars().next() else {
            break;
        };
        crate::inline::visit_container();
        result.push(ch);
        at += ch.len_utf8();
        old_column += ch.len_utf8();
        new_column += ch.len_utf8();
        if ch == '>' && depth < quote_depth {
            depth += 1;
            delta = delta
                .checked_add(shifts.get(&depth).copied().unwrap_or(0))
                .ok_or(super::EditorError::UnrepresentableFormat)?;
        }
    }
    if shifts.keys().any(|&quote| quote > depth) {
        return Err(super::EditorError::UnrepresentableFormat);
    }
    Ok(result)
}
