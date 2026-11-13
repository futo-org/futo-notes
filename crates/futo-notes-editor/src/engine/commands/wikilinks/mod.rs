//! Wikilinks and tags: `[[` completion, the vault's note ids (wikilink
//! resolution and note-link targets), own-action relinks, tag queries and
//! header-tag edits. Every edit here is one command through `Engine::run`;
//! note ids are not text and never touch the note or its history.
mod completion;
mod note_ids;
mod relink;
mod tags;

use crate::engine::command::Edit;
use crate::lines::{Kind, TableRole};

/// One edit turning `old`, which starts at source offset `start`, into
/// `new`, trimmed to the characters that differ.
fn trimmed(start: usize, old: &str, new: &str) -> Edit {
    let prefix = shared(old.chars(), new.chars());
    let suffix = shared(old[prefix..].chars().rev(), new[prefix..].chars().rev());
    Edit::new(
        start + prefix..start + old.len() - suffix,
        &new[prefix..new.len() - suffix],
    )
}

/// Bytes of the leading characters two iterators share.
fn shared(a: impl Iterator<Item = char>, b: impl Iterator<Item = char>) -> usize {
    a.zip(b)
        .take_while(|(x, y)| x == y)
        .map(|(c, _)| c.len_utf8())
        .sum()
}

/// Whether a line of this kind has inline marks (wikilinks, tags, code).
fn inline(kind: &Kind) -> bool {
    match kind {
        Kind::Plain { .. } | Kind::Heading { .. } | Kind::List { .. } => true,
        Kind::Table { role, .. } => *role != TableRole::Delimiter,
        _ => false,
    }
}
