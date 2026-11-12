//! `[[` completion. The engine reads the open run at the caret, ranks candidates
//! from the session's note-id index and turns an accepted candidate into one
//! ordinary isolated edit. A consumer never matches, spells or positions
//! anything. Cancelling is not calling accept: no completion state is kept.
use super::*;
use crate::{WikilinkCandidate, WikilinkCompletion};

/// Notes offered at once.
pub const WIKILINK_CANDIDATE_LIMIT: usize = 20;
/// A run longer than this (in bytes before the caret) is not offered.
const MAX_RUN_BYTES: usize = 512;

struct Run {
    /// Source bytes from the first `[` through the replaced `]]`, if any.
    source: std::ops::Range<usize>,
    display: DisplayRange,
    query: String,
}

/// Ids that can be written as `[[id]]` and read back as exactly that target.
fn writable(id: &str) -> bool {
    !id.is_empty() && !id.contains(['\n', '\r']) && !id.contains("]]") && !id.ends_with(']')
}

impl EditorSession {
    fn completion_run(&self) -> Option<Run> {
        if self.composition().is_some() || self.selection.start != self.selection.end {
            return None;
        }
        let caret = self.selection.start;
        let (low, high) = self.projection.source_bounds(caret.0);
        if low != high {
            return None;
        }
        let end_char = self.source.byte_to_char(low);
        let mut begin_char = self.source.byte_to_char(low.saturating_sub(MAX_RUN_BYTES));
        let mut window = self.source.slice(begin_char..end_char).to_string();
        if let Some(line_break) = window.rfind('\n') {
            begin_char += window[..=line_break].chars().count();
            window.drain(..=line_break);
        }
        if let Some(closed) = window.rfind(']') {
            begin_char += window[..=closed].chars().count();
            window.drain(..=closed);
        }
        let open = window.find("[[")?;
        let start = self.source.char_to_byte(begin_char) + open;
        if low - start > MAX_RUN_BYTES {
            return None;
        }
        if !self.projection.opens_literal_wikilink(start) {
            return None;
        }
        let closing = end_char + 2 <= self.source.len_chars()
            && self.source.slice(end_char..end_char + 2) == "]]";
        let end = if closing { low + 2 } else { low };
        Some(Run {
            display: DisplayRange {
                start: DisplayOffset(self.projection.display_at(start)),
                end: DisplayOffset(self.projection.display_at(end)),
            },
            query: window[open + 2..].to_owned(),
            source: start..end,
        })
    }

    /// The open `[[` run at the caret and the notes it offers, or `None` when
    /// there is no run (a selection, code, an escaped or link-owned bracket, a
    /// closed link, an open composition). Notes keep the delivered ranking.
    pub fn wikilink_completion(
        &self,
        expected: Revision,
    ) -> Result<Option<WikilinkCompletion>, EditorError> {
        on_next!(self, nothing);
        self.check_revision(expected)?;
        let Some(run) = self.completion_run() else {
            return Ok(None);
        };
        let catalog = &self.projection.catalog;
        let needle = futo_notes_wikilinks::fold(run.query.trim());
        let candidates = catalog
            .ordered()
            .filter(|(id, folded)| writable(id) && folded.contains(&needle))
            .take(WIKILINK_CANDIDATE_LIMIT)
            .map(|(id, _)| {
                let label = catalog.display_suffix(id);
                WikilinkCandidate {
                    detail: (label != id).then(|| id.to_owned()),
                    note_id: id.to_owned(),
                    label,
                }
            })
            .collect();
        Ok(Some(WikilinkCompletion {
            revision: self.revision,
            range: run.display,
            query: run.query,
            candidates,
        }))
    }

    /// Replace exactly the claimed run with `[[note_id]]` and put the caret after
    /// it, as one isolated accepted edit. The claim is the `range` and `query` a
    /// request returned. It is stale (`StaleRevision` after any edit,
    /// `StaleClaim` when the caret left the run, the run changed or the note
    /// is no longer in the delivered ids) and then nothing changes.
    pub fn accept_wikilink_completion(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        query: &str,
        note_id: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        self.check_revision(expected)?;
        if self.composition().is_some() {
            return Err(EditorError::CompositionActive);
        }
        let run = self
            .completion_run()
            .filter(|run| run.display == range && run.query == query)
            .ok_or(EditorError::StaleClaim)?;
        if !self.projection.catalog.contains(note_id) {
            return Err(EditorError::StaleClaim);
        }
        if !writable(note_id) {
            return Err(EditorError::InvalidText);
        }
        let link = format!("[[{note_id}]]");
        let after = run.source.start + link.len();
        self.edit_source(expected, run.source, &link, Some(after), accept)?
            .ok_or(EditorError::StaleClaim)
    }
}
