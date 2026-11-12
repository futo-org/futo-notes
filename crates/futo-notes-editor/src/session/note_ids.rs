//! Store-delivered note ids. Identity, backlinks and relink intent stay with the
//! store; the session only re-describes the wikilinks a delivery can change.
use super::*;
use crate::inline::wikilinks::{describe, describe_in_row, leaf_bit};
use crate::{NoteIdChange, NoteIdWork};
use futo_notes_wikilinks::{note_id_leaf, WikilinkIndex};
use std::collections::HashSet;

impl EditorSession {
    /// The note a tapped schemeless link destination names, among the delivered note ids, from
    /// the folder of `current_id`; `None` when it names no note.
    pub fn resolve_note_link(&self, current_id: &str, destination: &str) -> Option<String> {
        on_next!(ref self, |e| e.resolve_note_link(current_id, destination));
        crate::link_target::resolve_note_link(destination, current_id, &self.projection.catalog)
    }

    /// The destination to save for what was typed in the link prompt of the note `current_id`: a
    /// destination naming an existing note stays a note link as typed; otherwise a web-looking
    /// address gains `https://`.
    pub fn normalize_link_destination(&self, current_id: &str, typed: &str) -> String {
        on_next!(ref self, |e| e.normalize_link_destination(current_id, typed));
        crate::link_target::normalize_link_destination(typed, current_id, &self.projection.catalog)
    }

    /// Install the vault's current note ids. Source, display, selection, history
    /// and any composition are untouched, so this is valid while composing. Work
    /// is proportional to the id list plus the rows holding a link whose last
    /// component matches a changed id; other rows are never visited.
    pub fn update_note_ids(&mut self, note_ids: &[String]) -> NoteIdChange {
        on_next!(self, |e| e.update_note_ids(note_ids));
        let held = self.projection.catalog.ordered().map(|(id, _)| id);
        if held.eq(note_ids.iter().map(String::as_str)) {
            return NoteIdChange {
                revision: self.revision,
                projections: Vec::new(),
                work: NoteIdWork::default(),
            };
        }
        let next = WikilinkIndex::new(note_ids);
        let previous = std::mem::replace(&mut self.projection.catalog, Arc::new(next));
        let next = &self.projection.catalog;
        let mut work = NoteIdWork {
            catalog_items: next.build_items,
            ..NoteIdWork::default()
        };
        let mut leaves = HashSet::new();
        for (from, to) in [(&*previous, &**next), (&**next, &*previous)] {
            for id in from.ids() {
                work.catalog_items += 1;
                if !to.contains(id) {
                    leaves.insert(note_id_leaf(id).to_owned());
                }
            }
        }
        let mask = leaves.iter().fold(0, |mask, leaf| mask | leaf_bit(leaf));
        let mut changed = Vec::new();
        work.rows_visited = self
            .projection
            .rows
            .wikilink_rows(mask, &mut |row, _, display| {
                for link in &row.wikilinks {
                    work.links_examined += 1;
                    if !leaves.contains(note_id_leaf(&link.target)) {
                        continue;
                    }
                    if describe(&link.target, &previous) != describe(&link.target, next) {
                        changed.push(describe_in_row(row, display, link, next).range);
                    }
                }
            });
        NoteIdChange {
            revision: self.revision,
            projections: changed
                .into_iter()
                .map(|range| self.projection.query(self.revision, range))
                .collect(),
            work,
        }
    }
}
