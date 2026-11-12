//! Cells of a table line.
use std::ops::Range;

/// The cells of a line that starts with `|`, as ranges into `row` between
/// unescaped pipes, untrimmed. Text after the last pipe is a cell only when
/// it is not blank. A line that does not start with `|` has no cells.
pub(crate) fn cells(row: &str) -> Vec<Range<usize>> {
    let bytes = row.as_bytes();
    if bytes.first() != Some(&b'|') {
        return Vec::new();
    }
    let mut cells = Vec::new();
    let mut start = 1;
    let mut at = 1;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 2,
            b'|' => {
                cells.push(start..at);
                at += 1;
                start = at;
            }
            _ => at += 1,
        }
    }
    let end = bytes.len();
    if start < end && !row[start..end].trim_matches([' ', '\t']).is_empty() {
        cells.push(start..end);
    }
    cells
}

/// Each cell's content without its surrounding spaces and tabs.
pub(crate) fn trimmed(row: &str, cell: &Range<usize>) -> Range<usize> {
    let text = &row[cell.clone()];
    let lead = text.len() - text.trim_start_matches([' ', '\t']).len();
    let body = text.trim_matches([' ', '\t']);
    cell.start + lead..cell.start + lead + body.len()
}
