//! Quote prefix spelling shared by block commands.

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

/// Quote count is parser attribution; a source prefix contains no body text.
/// Container padding before a quote may exceed three columns after wide lists.
pub(super) fn canonical_quote_end(prefix: &str, depth: usize) -> Option<usize> {
    let mut at = 0;
    for _ in 0..depth {
        let next = prefix[at..].find('>')?;
        at += next + 1;
        if matches!(prefix.as_bytes().get(at), Some(b' ' | b'\t')) {
            at += 1;
        }
    }
    Some(at)
}
