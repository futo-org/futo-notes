//! The vault's note ids. The store reads them and delivers them; the core
//! resolves wikilinks and note-link destinations against them. A delivery
//! changes no text, selection, history or composition, and restyles only
//! the links whose resolution or label it changed.
use crate::engine::line::link_bit;
use crate::engine::project::resolve;
use crate::engine::Engine;
use crate::lines::SpanKind;
use crate::{DisplayOffset, DisplayRange, NoteIdChange, NoteIdWork};
use futo_notes_wikilinks::{note_id_leaf, WikilinkIndex};
use std::collections::HashSet;
use std::sync::Arc;

impl Engine {
    /// The note a tapped schemeless link destination names, from the folder
    /// of `current_id`; `None` when it names no delivered note.
    pub(crate) fn resolve_note_link(&self, current_id: &str, destination: &str) -> Option<String> {
        crate::link_target::resolve_note_link(destination, current_id, &self.notes)
    }

    /// The destination to save for what was typed in the link prompt of the
    /// note `current_id`.
    pub(crate) fn normalize_link_destination(&self, current_id: &str, typed: &str) -> String {
        crate::link_target::normalize_link_destination(typed, current_id, &self.notes)
    }

    /// Install the vault's note ids. Work is one pass over the id lists plus
    /// the lines holding a link whose last component matches a changed id,
    /// found through the store's link bits; other lines are not visited.
    pub(crate) fn update_note_ids(&mut self, note_ids: &[String]) -> NoteIdChange {
        let held = self.notes.ordered().map(|(id, _)| id);
        if held.eq(note_ids.iter().map(String::as_str)) {
            return NoteIdChange {
                revision: self.revision,
                projections: Vec::new(),
                work: NoteIdWork::default(),
            };
        }
        let next = Arc::new(WikilinkIndex::new(note_ids));
        let previous = std::mem::replace(&mut self.notes, next.clone());
        let mut work = NoteIdWork {
            catalog_items: next.build_items,
            ..NoteIdWork::default()
        };
        let mut leaves = HashSet::new();
        for (from, to) in [(&*previous, &*next), (&*next, &*previous)] {
            for id in from.ids() {
                work.catalog_items += 1;
                if !to.contains(id) {
                    leaves.insert(note_id_leaf(id).to_owned());
                }
            }
        }
        let mask = leaves.iter().fold(0, |mask, leaf| mask | link_bit(leaf));
        let mut changed = Vec::new();
        work.rows_visited = self.store.lines_linking(mask, |index, entry| {
            for span in &entry.spans {
                let SpanKind::Wikilink { target } = &span.kind else {
                    continue;
                };
                work.links_examined += 1;
                if leaves.contains(note_id_leaf(target))
                    && resolve(target, &previous) != resolve(target, &next)
                {
                    changed.push((index, span.range.clone()));
                }
            }
        });
        let projections = changed
            .into_iter()
            .map(|(index, range)| {
                let before = self.store.before(index);
                let entry = self.store.get(index);
                let at = |local: usize| DisplayOffset(before.display + entry.to_display(local));
                let range = DisplayRange {
                    start: at(range.start),
                    end: at(range.end),
                };
                self.projection(self.revision, range)
            })
            .collect();
        NoteIdChange {
            revision: self.revision,
            projections,
            work,
        }
    }
}
