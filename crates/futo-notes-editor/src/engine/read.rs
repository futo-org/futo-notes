//! Reading the note, whole and after an edit.
//!
//! After an edit the changed lines are read again, starting one line above
//! them (a delimiter row there may make that line a table header), and
//! reading continues until the carry at a line's start equals the carry that
//! line had before. When the edit can open or close front matter, reading
//! starts at line 1.
use super::line::{trimmed, Entry, Neighbors};
use super::store::{self, Size, Store};
use crate::lines::{Carry, FrontMatterRole, Kind, TableRole};
use std::ops::Range;

/// What an edit changed in the display.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Shown {
    /// The replaced display range, in the display before the edit.
    pub range: Range<usize>,
    pub inserted: String,
    /// The display of every line shown again, in the display after the edit:
    /// what a view restyles, even where the text did not change.
    pub lines: Range<usize>,
    /// Bytes of source the reader read again.
    pub parsed: usize,
    /// Bytes of source copied to build the changed lines.
    pub materialized: usize,
}

/// The note's text cut into lines, each with its ending; the last line has
/// none, so a note ending in a line break ends with an empty line.
pub(crate) fn split(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text.split_inclusive('\n').map(str::to_owned).collect();
    if lines.last().is_none_or(|line| line.ends_with('\n')) {
        lines.push(String::new());
    }
    lines
}

/// Read a whole note.
pub(crate) fn open(text: &str) -> Store {
    let texts = split(text);
    let closes = texts.iter().skip(1).any(|line| trimmed(line) == "---");
    let mut carry = Carry::start();
    let mut entries = Vec::with_capacity(texts.len());
    for text in texts {
        let entry = Entry::read(text, &mut carry, closes);
        place(&mut entries, entry);
    }
    for entry in &mut entries {
        entry.read_spans();
    }
    let count = entries.len();
    for index in 0..count {
        let next = entries.get(index + 1).map(|e| e.line.kind.clone());
        let neighbors = Neighbors {
            next: next.as_ref(),
            next_is_last: index + 2 == count,
        };
        entries[index].show(neighbors, index + 1 == count);
    }
    Store::new(entries)
}

/// Push `entry`; a delimiter row makes the line above it a table header.
fn place(entries: &mut Vec<Entry>, entry: Entry) {
    if let Kind::Table {
        role: TableRole::Delimiter,
        columns,
    } = entry.line.kind
    {
        if let Some(above) = entries.last_mut() {
            above.line.kind = Kind::Table {
                role: TableRole::Header,
                columns,
            };
        }
    }
    entries.push(entry);
}

/// Replace source `range` with `inserted` and read the changed lines again.
/// Returns what changed in the display.
pub(crate) fn edit(store: &mut Store, range: Range<usize>, inserted: &str) -> Shown {
    let count = store.len();
    let (first_changed, first_before) = line_at(store, range.start);
    let (last_changed, last_before) = line_at(store, range.end);
    let mut text = store.get(first_changed).text[..range.start - first_before.source].to_owned();
    text.push_str(inserted);
    text.push_str(&store.get(last_changed).text[range.end - last_before.source..]);
    let mut pieces: Vec<String> = text.split_inclusive('\n').map(str::to_owned).collect();
    if last_changed + 1 == count && pieces.last().is_none_or(|piece| piece.ends_with('\n')) {
        pieces.push(String::new());
    }
    let removed: Vec<&str> = (first_changed..=last_changed)
        .map(|index| trimmed(&store.get(index).text))
        .collect();
    let mut start = first_changed.saturating_sub(1);
    if front_matter_may_change(store, first_changed, &removed, &pieces) {
        start = 0;
    }

    // Read from `start` through the new lines, then on until the carry settles.
    let closes = |pieces: &[String]| {
        let in_pieces = |skip: usize| pieces.iter().skip(skip).any(|p| trimmed(p) == "---");
        let old = |range: Range<usize>| {
            range
                .into_iter()
                .any(|index| trimmed(&store.get(index).text) == "---")
        };
        if first_changed == 0 {
            in_pieces(1) || old(last_changed + 1..count)
        } else {
            old(1..first_changed) || in_pieces(0) || old(last_changed + 1..count)
        }
    };
    let first_text = if first_changed == 0 {
        pieces[0].as_str()
    } else {
        store.get(0).text.as_str()
    };
    let rest_closes = start == 0 && trimmed(first_text) == "---" && closes(&pieces);
    let mut carry = if start == 0 {
        Carry::start()
    } else {
        store.get(start).carry.clone()
    };
    let materialized = text.len();
    let mut read: Vec<Entry> = Vec::new();
    for index in start..first_changed {
        let entry = Entry::read(store.get(index).text.clone(), &mut carry, rest_closes);
        place(&mut read, entry);
    }
    for piece in pieces {
        let entry = Entry::read(piece, &mut carry, rest_closes);
        place(&mut read, entry);
    }
    let mut stop = last_changed + 1;
    while stop < count && store.get(stop).carry != carry {
        let entry = Entry::read(store.get(stop).text.clone(), &mut carry, rest_closes);
        place(&mut read, entry);
        stop += 1;
    }
    // A delimiter row where reading stopped keeps the line above as its header.
    if stop < count {
        if let Kind::Table {
            role: TableRole::Delimiter,
            columns,
        } = store.get(stop).line.kind
        {
            if let Some(above) = read.last_mut() {
                above.line.kind = Kind::Table {
                    role: TableRole::Header,
                    columns,
                };
            }
        }
    }
    for entry in &mut read {
        entry.read_spans();
    }
    let parsed: usize = read.iter().map(|entry| entry.text.len()).sum();

    // The display of a line depends on the line after it: recompute from one
    // line above the read lines.
    let shown_from = start.saturating_sub(1);
    let old_start = store.before(shown_from).display;
    let old_shown: String = store
        .iter_from(shown_from)
        .take(stop - shown_from)
        .map(Entry::display)
        .collect();
    let read_count = read.len();
    store.splice(start..stop, read);
    let new_count = store.len();
    let shown_to = start + read_count;
    for index in shown_from..shown_to {
        reshow(store, index, new_count);
    }
    let new_shown: String = store
        .iter_from(shown_from)
        .take(shown_to - shown_from)
        .map(Entry::display)
        .collect();
    Shown {
        parsed,
        materialized,
        ..trim(old_start, &old_shown, &new_shown)
    }
}

/// Work out line `index`'s display from its neighbors.
pub(crate) fn reshow(store: &mut Store, index: usize, count: usize) {
    let next = (index + 1 < count).then(|| store.get(index + 1).line.kind.clone());
    let neighbors = Neighbors {
        next: next.as_ref(),
        next_is_last: index + 2 == count,
    };
    store.update(index, |entry| entry.show(neighbors, index + 1 == count));
}

/// The line holding source offset `at`, and the size of the lines before it.
/// A line holds its start through its ending; the note's end is in its last line.
pub(crate) fn line_at(store: &Store, at: usize) -> (usize, Size) {
    store.line_past(store::source, at).unwrap_or_else(|| {
        let last = store.len() - 1;
        (last, store.before(last))
    })
}

/// Whether an edit can open or close front matter: line 1 is or was exactly
/// `---`, and the edit touches line 1 or adds or removes a `---` line.
fn front_matter_may_change(
    store: &Store,
    first_changed: usize,
    removed: &[&str],
    pieces: &[String],
) -> bool {
    let first = store.get(0);
    let was = matches!(first.line.kind, Kind::FrontMatter(FrontMatterRole::Open))
        || trimmed(&first.text) == "---";
    let now = if first_changed == 0 {
        pieces.first().is_some_and(|piece| trimmed(piece) == "---")
    } else {
        was
    };
    if !was && !now {
        return false;
    }
    first_changed == 0
        || removed.contains(&"---")
        || pieces.iter().any(|piece| trimmed(piece) == "---")
}

/// The smallest replacement that turns `old` into `new`, both starting at
/// display offset `start`.
fn trim(start: usize, old: &str, new: &str) -> Shown {
    let mut prefix = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(prefix) || !new.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let mut suffix = old[prefix..]
        .bytes()
        .rev()
        .zip(new[prefix..].bytes().rev())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(old.len() - suffix) || !new.is_char_boundary(new.len() - suffix) {
        suffix -= 1;
    }
    Shown {
        range: start + prefix..start + old.len() - suffix,
        inserted: new[prefix..new.len() - suffix].to_owned(),
        lines: start..start + new.len(),
        parsed: 0,
        materialized: 0,
    }
}
