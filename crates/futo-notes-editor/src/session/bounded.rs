//! Opt-in bounded code input. The full interface is recovered by materialization.
use super::*;
use crate::history::{ExactSelection, SourcePoint, SourceSelection};
use crate::SessionToken;
use serde::{Deserialize, Serialize};
use std::collections::LinkedList;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedCursor {
    pub token: SessionToken,
    pub incarnation: u64,
    pub revision: Revision,
    pub generation: u64,
}

/// Explicit payload work, not CPU or allocation timing. Ropey's internal tree
/// operations/allocations are excluded, as in EditWork. Entry/materialization
/// are proportional operations; only supported code input has fixed limits.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedWork {
    pub inspected_source_bytes: usize,
    pub input_bytes: usize,
    pub parsed_source_bytes: usize,
    pub copied_bytes: usize,
    /// Explicit fixed-size owned metadata records and retained length updates;
    /// not a count of instructions or Ropey internal node visits.
    pub metadata_items: usize,
    pub retired_history_records: usize,
    pub retired_history_payload_bytes: usize,
    pub returned_text_bytes: usize,
    pub returned_records: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundedError {
    Editor(EditorError),
    Unsupported,
    StaleCursor,
}

/// Rejected ownership transfer returns the original usable session.
pub struct BoundedEntryError {
    pub session: Box<EditorSession>,
    pub error: BoundedError,
}
impl std::fmt::Debug for BoundedEntryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(formatter)
    }
}

/// An affine map is supplied only by retained opaque-code identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeIdentity {
    pub source: SourceRange,
    pub display: DisplayRange,
}

/// A fragment does not claim to describe a complete physical block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeFragment {
    pub owner: SourceOffset,
    pub range: DisplayRange,
    pub language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedCodeProjection {
    pub range: DisplayRange,
    pub text: String,
    pub identity: CodeIdentity,
    pub block: CodeFragment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedChange {
    pub previous: BoundedCursor,
    pub cursor: BoundedCursor,
    pub range: DisplayRange,
    pub inserted: String,
    pub selection: DisplayRange,
    pub affinity: Affinity,
    pub projection: BoundedCodeProjection,
    pub work: BoundedWork,
}

/// The original session, its source/history and its canonical transient fields
/// keep one owner. The old projection is private retained metadata until the
/// explicit full-interface handoff; code input never mutates its giant row.
pub struct BoundedEditorSession {
    engine: EditorSession,
    code: crate::inline::bounded::RetainedCode,
    display: Rope,
    token: SessionToken,
    generation: u64,
    history_selection: SourceSelection,
    preparation: BoundedWork,
    // One allocation per accepted record avoids moving an ever-growing Vec on
    // a local key. These exact records catch up the retained projection at the
    // explicit materializing handoff; there is no whole-source snapshot.
    unapplied: LinkedList<AcceptedCodeInput>,
    retired_redo: Vec<HistoryGroup>,
}

struct AcceptedCodeInput {
    edit: SourceEdit,
    history: HistoryEntry,
    joins_previous: bool,
}

impl EditorSession {
    /// Explicit proportional preparation, not a bounded cold-open operation.
    /// On rejection the error retains this exact session and its history.
    pub fn into_bounded(
        mut self,
        expected: Revision,
        token: SessionToken,
        body_caret: DisplayOffset,
    ) -> Result<BoundedEditorSession, BoundedEntryError> {
        let fail = |session, error| {
            Err(BoundedEntryError {
                session: Box::new(session),
                error,
            })
        };
        if let Err(error) = self.check_revision(expected) {
            return fail(self, BoundedError::Editor(error));
        }
        if self.composition.is_some() {
            return fail(self, BoundedError::Editor(EditorError::CompositionActive));
        }
        if let Err(error) = self.char_index(body_caret) {
            return fail(self, BoundedError::Editor(error));
        }
        let Some((code, metadata_items, copied_bytes)) =
            self.projection.retain_bounded_code(body_caret)
        else {
            return fail(self, BoundedError::Unsupported);
        };
        let Some(incarnation) = self.bounded_incarnation.checked_add(1) else {
            return fail(self, BoundedError::Editor(EditorError::RevisionExhausted));
        };
        self.bounded_incarnation = incarnation;
        let (history_selection, history_work) = self.capture_history_selection();
        let display = self.projection.display.clone();
        Ok(BoundedEditorSession {
            engine: self,
            code,
            display,
            token,
            generation: 0,
            history_selection,
            preparation: BoundedWork {
                metadata_items: metadata_items + history_work,
                copied_bytes,
                ..Default::default()
            },
            unapplied: LinkedList::new(),
            retired_redo: Vec::new(),
        })
    }
}

impl BoundedEditorSession {
    pub fn cursor(&self) -> BoundedCursor {
        BoundedCursor {
            token: self.token,
            incarnation: self.engine.bounded_incarnation,
            revision: self.engine.revision(),
            generation: self.generation,
        }
    }

    pub fn preparation_work(&self) -> BoundedWork {
        self.preparation
    }

    /// Explicit whole-source materialization; never used by a local input.
    pub fn source_text(&self) -> String {
        self.engine.source_text()
    }
    /// Explicit whole-display materialization; never used by a local input.
    pub fn display_text(&self) -> String {
        self.display.to_string()
    }

    /// The first supported slice inserts one non-newline, non-fence-marker
    /// scalar into retained opaque code. Other operations require a deliberate
    /// materializing handoff; this method never falls back to full planning.
    pub fn insert_literal(
        &mut self,
        cursor: BoundedCursor,
        at: DisplayOffset,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<BoundedChange, BoundedError> {
        if cursor != self.cursor() {
            return Err(BoundedError::StaleCursor);
        }
        if inserted.len() > 4
            || inserted.chars().count() != 1
            || inserted.contains(['\r', '\n', '`', '~'])
        {
            return Err(BoundedError::Unsupported);
        }
        if at.0 < self.code.display.start || self.code.display.end < at.0 {
            return Err(BoundedError::Unsupported);
        }
        let mut work = BoundedWork {
            input_bytes: inserted.len(),
            ..Default::default()
        };
        let generation = self
            .generation
            .checked_add(1)
            .ok_or(BoundedError::Editor(EditorError::RevisionExhausted))?;
        let source = SourceOffset(self.code.body.start + at.0 - self.code.display.start);
        let edit = self
            .engine
            .prepare_source(
                cursor.revision,
                SourceRange {
                    start: source,
                    end: source,
                },
                inserted,
            )
            .map_err(BoundedError::Editor)?;
        work.copied_bytes += edit.inserted.len();
        work.metadata_items += 1; // prepared source record
        let before_selection = self.engine.selection;
        let before_affinity = self.engine.affinity;
        let before_formats = self.engine.pending_formats.clone();
        work.metadata_items += before_formats.as_ref().map_or(0, Vec::len);
        let affinity = self
            .engine
            .input_affinity(DisplayRange { start: at, end: at });
        accept(&edit).map_err(|error| BoundedError::Editor(EditorError::Persistence(error)))?;
        let char_index = self.engine.source.byte_to_char(source.0);
        self.engine.source.insert(char_index, inserted);
        self.display
            .insert(self.display.byte_to_char(at.0), inserted);
        self.engine.revision = edit.revision;
        let caret = DisplayOffset(at.0 + inserted.len());
        self.engine.selection = DisplayRange {
            start: caret,
            end: caret,
        };
        self.engine.affinity = affinity;
        self.engine.pending_formats = None;
        let after_source = SourcePoint {
            source: SourceOffset(source.0 + inserted.len()),
            within: 0,
            atom: None,
        };
        let after_source = SourceSelection::Exact(ExactSelection {
            start: after_source,
            end: after_source,
        });
        let before_links = opaque_pending(self.code.whole.clone());
        work.metadata_items += 4; // source point, exact range, selection and pending snapshot
        self.code.body.end += inserted.len();
        self.code.display.end += inserted.len();
        self.code.whole.end += inserted.len();
        work.metadata_items += 3; // retained length updates
        let joins_previous = self.engine.input_joins_history(
            Some(&HistoryInput {
                range: DisplayRange { start: at, end: at },
                inserted,
                action: crate::InputAction::Typing,
            }),
            before_selection,
        );
        if self.unapplied.is_empty() {
            // Move invalidated redo ownership; dropping a large redo branch is
            // charged at the explicit materializing handoff, never on this key.
            self.retired_redo = std::mem::take(&mut self.engine.redo);
            work.metadata_items += 1;
        }
        let record = edit.clone();
        work.copied_bytes += record.inserted.len();
        let history = HistoryEntry {
            before_source: self.history_selection,
            after_source,
            before_selection,
            before_affinity,
            before_formats,
            before_links,
            after_selection: self.engine.selection,
            after_affinity: affinity,
            after_formats: None,
            after_links: opaque_pending(self.code.whole.clone()),
            range: edit.range,
            removed: edit.removed,
            inserted: edit.inserted,
        };
        self.unapplied.push_back(AcceptedCodeInput {
            edit: record,
            history,
            joins_previous,
        });
        work.metadata_items += 5; // grouping state, accepted record, history and two pending/point copies
        self.history_selection = after_source;
        self.generation = generation;
        let range = DisplayRange {
            start: at,
            end: caret,
        };
        work.copied_bytes +=
            inserted.len() * 2 + self.code.language.as_ref().map_or(0, String::len);
        work.returned_text_bytes = inserted.len() * 2;
        work.returned_records = 2;
        work.metadata_items += 6; // identity, block, projection, change and two cursor records
        Ok(BoundedChange {
            previous: cursor,
            cursor: self.cursor(),
            range: DisplayRange { start: at, end: at },
            inserted: inserted.to_owned(),
            selection: self.engine.selection,
            affinity,
            projection: BoundedCodeProjection {
                range,
                text: inserted.to_owned(),
                identity: CodeIdentity {
                    source: SourceRange {
                        start: source,
                        end: SourceOffset(source.0 + inserted.len()),
                    },
                    display: range,
                },
                block: CodeFragment {
                    owner: SourceOffset(self.code.whole.start),
                    range,
                    language: self.code.language.clone(),
                },
            },
            work,
        })
    }

    /// Explicitly proportional handoff. Replay the actual accepted edits into
    /// the retained canonical projection in the same engine, preserving its
    /// transient witnesses. No callback, new source acceptance or history step.
    pub fn materialize(mut self) -> (EditorSession, BoundedWork) {
        let selection = self.engine.selection;
        let affinity = self.engine.affinity;
        let formats = self.engine.pending_formats.take();
        let mut work = BoundedWork::default();
        for accepted in self.unapplied.iter().rev() {
            let edit = &accepted.edit;
            let start = self.engine.source.byte_to_char(edit.range.start.0);
            let end = self
                .engine
                .source
                .byte_to_char(edit.range.start.0 + edit.inserted.len());
            self.engine.source.remove(start..end);
            self.engine.source.insert(start, &edit.removed);
            self.engine.revision = edit.previous_revision;
            work.inspected_source_bytes += edit.inserted.len() + edit.removed.len();
        }
        if !self.unapplied.is_empty() {
            // Compose only at this explicit proportional handoff. One canonical
            // apply preserves transient fields without reparsing the giant row
            // once for every earlier key.
            let mut transaction = crate::history::Transaction::new(&self.engine.source);
            let final_revision = self.unapplied.back().unwrap().edit.revision;
            for accepted in &self.unapplied {
                transaction.apply(accepted.edit.range, &accepted.edit.inserted);
                work.input_bytes += accepted.edit.inserted.len();
            }
            let (range, inserted) = transaction.finish();
            let mut edit = self
                .engine
                .prepare_source(self.engine.revision, range, &inserted)
                .expect("accepted code records compose into their original source");
            edit.revision = final_revision;
            work.copied_bytes += edit.removed.len() + inserted.len() + edit.inserted.len();
            let change = self.engine.apply(&edit);
            work.inspected_source_bytes += change.work.materialized_source_bytes;
            work.parsed_source_bytes += change.work.parsed_source_bytes;
            work.copied_bytes += change.work.materialized_source_bytes
                + change.work.link_copied_bytes
                + change.inserted.len()
                + change.projection.text.len();
            work.metadata_items += change.work.link_metadata_items
                + change.projection.correspondence.len()
                + change.projection.blocks.len()
                + change.projection.runs.len()
                + change.projection.links.len();
        }
        for accepted in self.unapplied {
            if accepted.joins_previous {
                self.engine
                    .undo
                    .last_mut()
                    .unwrap()
                    .entries
                    .push(accepted.history);
            } else {
                self.engine.undo.push(HistoryGroup {
                    entries: vec![accepted.history],
                });
            }
            work.metadata_items += 1;
        }
        for group in &self.retired_redo {
            work.retired_history_records += 1 + group.entries.len();
            for entry in &group.entries {
                work.retired_history_payload_bytes += entry.removed.len() + entry.inserted.len();
            }
        }
        self.engine.selection = selection;
        self.engine.affinity = affinity;
        self.engine.pending_formats = formats;
        (self.engine, work)
    }
}

fn opaque_pending(window: std::ops::Range<usize>) -> crate::inline::PendingLinks {
    crate::inline::PendingLinks {
        window,
        ranges: Vec::new(),
        delimiters: Vec::new(),
        guarded_words: Vec::new(),
        typed_inputs: Vec::new(),
        work: 0,
    }
}
