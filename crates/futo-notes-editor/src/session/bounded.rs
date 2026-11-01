//! Opt-in bounded code input. The full interface is recovered by materialization.
use super::*;
use crate::history::{ExactSelection, SourcePoint, SourceSelection};
use crate::SessionToken;
use serde::{Deserialize, Serialize};
use std::collections::LinkedList;

mod contract;
pub use contract::*;
mod history;
mod input;
mod materialize;
mod prefix;
mod progress;
mod restore;
mod selection;
mod source;
pub use source::{BoundedSourceAuthority, BoundedSourceOperation, BoundedSourceSession};
use source::{SourceRecord, SourceRegion};

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
    last_operation: BoundedWork,
    // One allocation per accepted record avoids moving an ever-growing Vec on
    // a local key. These exact records catch up the retained projection at the
    // explicit materializing handoff; there is no whole-source snapshot.
    source_records: LinkedList<SourceRecord>,
    closer: String,
    dirty_suffix: i64,
    source_transport: bool,
    deferred: LinkedList<AcceptedCodeInput>,
    redo_groups: LinkedList<LinkedList<AcceptedCodeInput>>,
    retired_groups: LinkedList<LinkedList<AcceptedCodeInput>>,
    accepted_any: bool,
    retired_redo: Vec<HistoryGroup>,
    progress: Option<progress::ProgressState>,
    prefix: Option<crate::inline::bounded::PlainPrefix>,
}

struct AcceptedCodeInput {
    history: HistoryEntry,
    joins_previous: bool,
    kind: AcceptedKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FrameKind {
    Fence,
    Region,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AcceptedKind {
    Literal,
    Closer,
    Prefix,
}

impl EditorSession {
    /// Retained on this Full owner when a consuming bounded entry is refused.
    pub fn last_bounded_operation_work(&self) -> BoundedWork {
        self.bounded_work
    }

    /// Explicit proportional preparation, not a bounded cold-open operation.
    /// On rejection the error retains this exact session and its history.
    pub fn into_bounded(
        mut self,
        expected: Revision,
        token: SessionToken,
        body_caret: DisplayOffset,
    ) -> Result<BoundedEditorSession, BoundedEntryError> {
        let mut work = BoundedWork::default();
        let fail = |mut session: Self, error, work| {
            session.bounded_work = work;
            Err(BoundedEntryError {
                session: Box::new(session),
                work,
                error,
            })
        };
        if let Err(error) = self.check_revision(expected) {
            return fail(self, BoundedError::Editor(error), work);
        }
        if self.composition.is_some() {
            return fail(
                self,
                BoundedError::Editor(EditorError::CompositionActive),
                work,
            );
        }
        if let Err(error) = self.char_index(body_caret) {
            return fail(self, BoundedError::Editor(error), work);
        }
        let Some(code) = self.projection.retain_bounded_code(body_caret, &mut work) else {
            return fail(self, BoundedError::Unsupported, work);
        };
        let Some(incarnation) = self.bounded_incarnation.checked_add(1) else {
            return fail(
                self,
                BoundedError::Editor(EditorError::RevisionExhausted),
                work,
            );
        };
        self.bounded_incarnation = incarnation;
        let (progress, progress_work) = progress::ProgressState::prepare(&self, &code);
        let (prefix, prefix_work) = self.projection.bounded_plain_prefix(&self.source, &code);
        let (history_selection, history_work) = self.capture_history_selection();
        let display = self.projection.display.clone();
        let closer = progress.as_ref().map_or_else(String::new, |progress| {
            self.source
                .byte_slice(progress.certificate.closer.clone())
                .to_string()
        });
        work.inspected_source_bytes +=
            progress_work.inspected_source_bytes + prefix_work.inspected_source_bytes;
        work.metadata_items +=
            history_work + progress_work.metadata_items + prefix_work.metadata_items;
        work.copied_bytes += progress_work.copied_bytes + prefix_work.copied_bytes + closer.len();
        self.bounded_work = work;
        Ok(BoundedEditorSession {
            engine: self,
            closer,
            dirty_suffix: 0,
            source_transport: false,
            code,
            display,
            token,
            generation: 0,
            history_selection,
            preparation: work,
            last_operation: work,
            source_records: LinkedList::new(),
            deferred: LinkedList::new(),
            redo_groups: LinkedList::new(),
            retired_groups: LinkedList::new(),
            accepted_any: false,
            retired_redo: Vec::new(),
            progress,
            prefix,
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

    fn discard_redo(&mut self) {
        if !self.accepted_any {
            self.retired_redo = std::mem::take(&mut self.engine.redo);
            self.accepted_any = true;
        }
        self.retired_groups.append(&mut self.redo_groups);
    }

    /// Latest completed bounded attempt for a serialized caller. Reading this
    /// receipt does not pair it atomically with an earlier competing call.
    /// Queries do not replace it; the next attempted operation does.
    pub fn last_operation_work(&self) -> BoundedWork {
        self.last_operation
    }

    pub fn preparation_work(&self) -> BoundedWork {
        self.preparation
    }

    /// Explicit whole-source materialization; never used by a local input.
    pub fn source_text(&self) -> String {
        self.engine.source_text()
    }
    /// Explicit whole-display materialization; never used by a local input.
    pub(crate) fn display_bytes(&self) -> usize {
        self.display.len_bytes()
    }
    pub fn display_text(&self) -> String {
        self.display.to_string()
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
