//! The fixed repair set: escape a leading character, insert a blank line or
//! an empty-comment separator, or respell a changed list with the other marker.
use super::*;

/// Keep a body's leading text literal where it would otherwise start block
/// syntax or lose leading whitespace: (offset, removed bytes, inserted text).
pub(super) fn escape(body: &str) -> Option<(usize, usize, String)> {
    let bytes = body.as_bytes();
    let first = *bytes.first()?;
    if matches!(first, b' ' | b'\t') {
        return Some((0, 1, format!("&#{first};")));
    }
    let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    if digits > 0 && matches!(bytes.get(digits), Some(b'.' | b')')) {
        return Some((digits, 0, "\\".into()));
    }
    matches!(
        first,
        b'#' | b'>' | b'-' | b'+' | b'*' | b'=' | b'`' | b'~' | b'_' | b'|' | b'<' | b'['
    )
    .then(|| (0, 0, "\\".into()))
}

#[derive(Clone, Copy)]
pub(super) enum Repair {
    Escape(usize),
    Insert(usize, Insert),
    Alternate(usize),
}

impl Repair {
    pub(super) fn apply(self, rows: &mut [Row]) {
        match self {
            Self::Escape(at) => rows[at].escape = true,
            Self::Insert(at, insert) => rows[at].insert = insert,
            Self::Alternate(end) => {
                // The whole changed list around `end` takes the other marker.
                let (depth, key) = (rows[end].after.depth, rows[end].key);
                let inside = |row: &Row| {
                    (row.changed() || row.blank) && (row.blank || row.after.depth >= depth)
                };
                let start = (0..=end)
                    .rev()
                    .take_while(|&at| inside(&rows[at]))
                    .last()
                    .unwrap_or(end);
                let stop = (end..rows.len())
                    .take_while(|&at| inside(&rows[at]))
                    .last()
                    .unwrap_or(end);
                for row in &mut rows[start..=stop] {
                    if row.changed()
                        && row.after.opens
                        && row.after.depth == depth
                        && row.key == key
                    {
                        row.after.marker = match row.after.marker {
                            b'-' => b'+',
                            b'+' => b'*',
                            b'*' => b'-',
                            b'.' => b')',
                            _ => b'.',
                        };
                    }
                }
            }
        }
    }
}

/// The fixed repair set for the first mismatching row, in preference order.
pub(super) fn repairs(rows: &[Row], at: usize) -> Vec<Repair> {
    let mut options = Vec::new();
    let row = &rows[at];
    if row.changed() && !row.blank && !row.escape && row.escapable {
        options.push(Repair::Escape(at));
    }
    let boundary =
        at > 0 && (row.changed() || rows[at - 1].changed()) && row.insert == Insert::None;
    if boundary {
        options.push(Repair::Insert(at, Insert::Blank));
    }
    let run = (0..=at)
        .rev()
        .find(|&index| rows[index].changed() && rows[index].after.opens);
    // A list that joins an unchanged one keeps that list's marker.
    if let Some(end) = run.filter(|&end| {
        !rows
            .iter()
            .any(|row| !row.changed() && row.after.opens && row.key == rows[end].key)
    }) {
        options.push(Repair::Alternate(end));
    }
    // An empty item written by the command breaks the paragraph ABOVE it (an
    // empty item cannot interrupt one, and a `-` reads as a setext
    // underline): separate them. The first mismatch is the top of a
    // multi-line block (the setext heading, table or HTML block it spoils),
    // so the item can be any row after it.
    if let Some(next) = (at + 1..rows.len()).find(|&index| rows[index].from_blank) {
        if rows[next].insert == Insert::None {
            options.push(Repair::Insert(next, Insert::Blank));
        }
    }
    options
}
