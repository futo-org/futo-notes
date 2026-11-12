//! `[[` completion: the open run at the caret, the notes it offers, and an
//! accepted candidate as one command. No completion state is kept, so
//! cancelling is not calling accept.
use super::{inline, trimmed};
use crate::engine::command::Command;
use crate::engine::line::Role;
use crate::engine::Engine;
use crate::lines::SpanKind;
use crate::{
    DisplayOffset, DisplayRange, EditorError, Revision, SourceEdit, ViewChange, WikilinkCandidate,
    WikilinkCompletion,
};
use std::ops::Range;

/// Notes offered at once.
const CANDIDATE_LIMIT: usize = 20;
/// A run longer than this (source bytes before the caret) is not offered.
const MAX_RUN_BYTES: usize = 512;

struct Run {
    /// Source from the first `[` through the caret, and through a `]]`
    /// right after it.
    source: Range<usize>,
    display: DisplayRange,
    /// The source typed after `[[`.
    query: String,
}

/// Ids that can be written as `[[id]]` and read back as exactly that target.
fn writable(id: &str) -> bool {
    !id.is_empty() && !id.contains(['\n', '\r']) && !id.contains("]]") && !id.ends_with(']')
}

impl Engine {
    /// The open `[[` run before a collapsed caret on its line: after the
    /// line's last `]`, with both brackets shown as typed (not hidden
    /// syntax, not escaped, not in code or an image), on a line with inline
    /// marks, with no composition.
    fn completion_run(&self) -> Option<Run> {
        if self.composition.is_some() || self.selection.start != self.selection.end {
            return None;
        }
        let (at, high) = self.source_bounds(self.selection.start.0);
        if at != high {
            return None;
        }
        let index = self.line_of(at);
        let entry = self.line(index);
        if entry.view.role != Role::Text || !inline(&entry.line.kind) {
            return None;
        }
        let line_start = self.line_start(index);
        let caret = at - line_start;
        if caret > entry.body_len() {
            return None;
        }
        let mut from = caret.saturating_sub(MAX_RUN_BYTES);
        while !entry.text.is_char_boundary(from) {
            from += 1;
        }
        let window = &entry.text[from..caret];
        let after_close = window.rfind(']').map_or(0, |close| close + 1);
        let open = from + after_close + window[after_close..].find("[[")?;
        let literal = |at: usize| {
            !entry.view.cuts.iter().any(|(cut, _)| cut.contains(&at))
                && !entry.spans.iter().any(|span| {
                    matches!(
                        span.kind,
                        SpanKind::Code | SpanKind::Image { .. } | SpanKind::Escape
                    ) && span.range.contains(&at)
                })
        };
        if !literal(open) || !literal(open + 1) {
            return None;
        }
        let end = if entry.text[caret..].starts_with("]]") {
            caret + 2
        } else {
            caret
        };
        let (start, end) = (line_start + open, line_start + end);
        Some(Run {
            display: DisplayRange {
                start: DisplayOffset(self.display_of(start)),
                end: DisplayOffset(self.display_of(end)),
            },
            query: entry.text[open + 2..caret].to_owned(),
            source: start..end,
        })
    }

    /// The open `[[` run at the caret and up to 20 notes whose folded id
    /// holds the trimmed folded query, in delivered order; `None` when there
    /// is no run.
    pub(crate) fn wikilink_completion(
        &self,
        expected: Revision,
    ) -> Result<Option<WikilinkCompletion>, EditorError> {
        self.check_revision(expected)?;
        let Some(run) = self.completion_run() else {
            return Ok(None);
        };
        let needle = futo_notes_wikilinks::fold(run.query.trim());
        let candidates = self
            .notes
            .ordered()
            .filter(|(id, folded)| writable(id) && folded.contains(&needle))
            .take(CANDIDATE_LIMIT)
            .map(|(id, _)| {
                let label = self.notes.display_suffix(id);
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

    /// Replace exactly the claimed run with `[[note_id]]`, the caret after
    /// it, as one command. The claim is stale (`StaleClaim`) when the caret
    /// left the run, the run changed or the id is no longer delivered.
    pub(crate) fn accept_wikilink_completion(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        query: &str,
        note_id: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let run = self
            .completion_run()
            .filter(|run| run.display == range && run.query == query)
            .ok_or(EditorError::StaleClaim)?;
        if !self.notes.contains(note_id) {
            return Err(EditorError::StaleClaim);
        }
        if !writable(note_id) {
            return Err(EditorError::InvalidText);
        }
        let link = format!("[[{note_id}]]");
        let caret = run.source.start + link.len();
        let line = self.line_of(run.source.start);
        let edit = trimmed(
            run.source.start,
            &self.source_slice(run.source.clone()),
            &link,
        );
        let command = Command::new(vec![edit], line..line + 1, caret..caret);
        let change = self
            .run(expected, |_| Ok(Some(command)), accept)?
            .ok_or(EditorError::StaleClaim)?;
        Ok(self.view(change))
    }
}
