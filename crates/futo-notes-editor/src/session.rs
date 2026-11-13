//! The surface hosts call: one session per open note. Every method hands its
//! work to the core (`crate::engine`); this layer keeps the public names,
//! the image and adoption claims, and the marked text as hosts read it.
mod commands;
mod external;
mod find;
mod types;

pub use external::ExternalSourceAdoption;
pub use find::{FindReport, FindScanRequest, FindScanResult, FindWork};
pub use types::{BlockCommand, Composition, MarkedRun, ParagraphKey, ToolbarList, ToolbarState};

use crate::engine::Engine;
use crate::history::{HistoryClock, MonotonicClock};
use crate::{
    Affinity, CaretDirection, DisplayOffset, DisplayRange, DisplayReplacement, EditorError,
    InlineFormat, InputAction, ProjectionSlice, Revision, SelectionChange, SourceEdit,
    SourceOffset, ViewChange,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

type Accept<'a> = &'a mut dyn FnMut(&SourceEdit) -> Result<(), String>;

/// Exact-source editor session.
pub struct EditorSession {
    engine: Engine,
    /// The marked text as hosts read it, refreshed after every call that can
    /// change it.
    composition: Option<Composition>,
    /// Names this session for image claims and adoptions; never reused within
    /// a process.
    incarnation: u64,
}

fn next_incarnation() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

impl EditorSession {
    pub fn open(source: &str) -> Self {
        Self::restore(source, Revision(0))
    }

    /// Starts a session at a given revision without persistent undo history.
    pub fn restore(source: &str, revision: Revision) -> Self {
        Self::restore_with_clock(source, revision, Arc::new(MonotonicClock::default()))
    }

    pub fn open_with_clock(source: &str, clock: Arc<dyn HistoryClock>) -> Self {
        Self::restore_with_clock(source, Revision(0), clock)
    }

    pub fn restore_with_clock(
        source: &str,
        revision: Revision,
        clock: Arc<dyn HistoryClock>,
    ) -> Self {
        Self {
            engine: Engine::restore_with_clock(source, revision, clock),
            composition: None,
            incarnation: next_incarnation(),
        }
    }

    /// Run `f` on the core, then refresh the marked text hosts read.
    fn run<R>(&mut self, f: impl FnOnce(&mut Engine) -> R) -> R {
        let result = f(&mut self.engine);
        self.composition = self.engine.composition().map(|marked| Composition {
            revision: marked.revision,
            range: marked.range,
            text: marked.text.clone(),
            runs: marked_runs(&self.engine, marked.range, &marked.text),
        });
        result
    }

    pub(crate) fn engine(&self) -> &Engine {
        &self.engine
    }

    pub fn revision(&self) -> Revision {
        self.engine.revision()
    }

    /// Explicit whole-text query; never called by the input path.
    pub fn source_text(&self) -> String {
        self.engine.source_text()
    }

    pub fn display_text(&self) -> String {
        self.engine.display_text()
    }

    pub fn selection(&self) -> DisplayRange {
        self.engine.selection()
    }

    pub fn affinity(&self) -> Affinity {
        self.engine.affinity()
    }

    pub fn active_formats(&self) -> Vec<InlineFormat> {
        self.engine.active_formats()
    }

    pub fn composition(&self) -> Option<&Composition> {
        self.composition.as_ref()
    }

    /// Validate ordering before a host converts fixed-width foreign coordinates.
    pub fn check_revision(&self, expected: Revision) -> Result<(), EditorError> {
        self.engine.check_revision(expected)
    }

    pub fn select(
        &mut self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<SelectionChange, EditorError> {
        let affinity = if range.start.0 == 0 {
            Affinity::Forward
        } else {
            Affinity::Backward
        };
        self.select_with_affinity(expected, range, affinity)
    }

    pub fn select_with_affinity(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        affinity: Affinity,
    ) -> Result<SelectionChange, EditorError> {
        self.run(|e| e.select_with_affinity(expected, range, affinity))
    }

    /// Move one extended grapheme in the requested direction, collapsing a
    /// nonempty selection to its corresponding edge without an extra step.
    pub fn move_caret(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<SelectionChange, EditorError> {
        self.run(|e| e.move_caret(expected, direction))
    }

    pub fn source_at(
        &self,
        expected: Revision,
        offset: DisplayOffset,
        affinity: Affinity,
    ) -> Result<SourceOffset, EditorError> {
        self.engine.source_at(expected, offset, affinity)
    }

    pub fn project(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<ProjectionSlice, EditorError> {
        self.engine.project(expected, range)
    }

    /// `accept` must protect the record against process death before returning
    /// success. A WASM-local success alone cannot provide that acknowledgement.
    /// The exclusive session borrow prevents synchronous acceptance callbacks from
    /// re-entering input; a later native echo must retain its original revision.
    ///
    /// ```compile_fail,E0499
    /// use futo_notes_editor::{DisplayRange, EditorSession, Revision};
    /// let mut session = EditorSession::open("text");
    /// session.replace(Revision(0), DisplayRange::default(), "!", &mut |_| {
    ///     session.select(Revision(0), DisplayRange::default()).unwrap();
    ///     Ok(())
    /// });
    /// ```
    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: Accept,
    ) -> Result<ViewChange, EditorError> {
        self.replace_action(expected, range, inserted, InputAction::Typing, accept)
    }

    /// Paste, correction, compound actions and final composition commits are
    /// isolated; provisional marked text must never enter this source method.
    pub fn replace_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: InputAction,
        accept: Accept,
    ) -> Result<ViewChange, EditorError> {
        self.run(|e| e.input(expected, range, inserted, action, accept))
    }

    /// Placeholder ranges address the inserted UTF-8 string and must contain
    /// only actual platform U+FFFC placeholders. An untagged U+FFFC is literal
    /// user content, including when it already exists in exact source.
    pub fn replace_os(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        placeholders: &[DisplayRange],
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        let text = clean_placeholders(text, placeholders)?;
        self.run(|e| e.input(expected, range, &text, InputAction::Isolated, accept))
            .map(Some)
    }

    /// Apply one user action whose nonoverlapping runs address the opening
    /// display. Unchanged runs retain their original source spelling. Empty,
    /// unordered, overlapping and invalid inputs reject without acceptance.
    pub fn replace_many(
        &mut self,
        expected: Revision,
        replacements: &[DisplayReplacement],
        accept: Accept,
    ) -> Result<ViewChange, EditorError> {
        self.run(|e| {
            e.replace_runs(expected, replacements, accept)
                .map(|change| match change {
                    Some(change) => e.view(change),
                    None => e.unchanged(),
                })
        })
    }

    /// Replay accepts only a record that matches both revision and exact bytes.
    pub fn replay(&mut self, edit: &SourceEdit) -> Result<ViewChange, EditorError> {
        self.replay_with_accept(edit, &mut |_| Ok(()))
    }

    /// Validate exact source before host acceptance; failed records leave state intact.
    pub fn replay_with_accept(
        &mut self,
        edit: &SourceEdit,
        accept: Accept,
    ) -> Result<ViewChange, EditorError> {
        self.run(|e| e.replay_view(edit, accept))
    }

    pub fn undo(
        &mut self,
        expected: Revision,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| e.history_view(expected, false, accept))
    }

    pub fn redo(
        &mut self,
        expected: Revision,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| e.history_view(expected, true, accept))
    }

    /// Repeated updates retain the opening range. Hosts supply the complete
    /// marked string, including when a native IME replaces its last character.
    pub fn compose(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Composition, EditorError> {
        self.run(|e| e.compose(expected, range, text))?;
        Ok(self.composition.clone().expect("marked text after compose"))
    }

    /// A changed native commit replaces the staged string. Failed recovery
    /// acceptance leaves the marked text available for retry or cancellation.
    pub fn commit_composition(
        &mut self,
        expected: Revision,
        text: Option<&str>,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| e.commit_view(expected, text, accept))
    }

    pub fn cancel_composition(&mut self, expected: Revision) -> Result<(), EditorError> {
        self.run(|e| e.cancel_composition(expected))
    }

    /// Enter and Shift+Enter, Backspace and Delete, Tab and Shift+Tab: the
    /// command a block family claims the key for on the lines it is pointed
    /// at, else typing. Boundary deletion is a no-op with no acceptance,
    /// revision or history.
    pub fn paragraph_key(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        key: ParagraphKey,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| e.key(expected, range, key, accept))
    }

    /// A toolbar block command on the lines `range` touches.
    pub fn block_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| e.block(expected, range, command, accept))
    }

    /// Selection-wide formats and common blocks, plus command eligibility.
    pub fn toolbar_state(&self) -> ToolbarState {
        self.engine.toolbar()
    }

    /// A collapsed toggle changes the carried format without writing empty
    /// markdown. A selected toggle is one accepted, byte-exact history action.
    pub fn toggle_format(
        &mut self,
        expected: Revision,
        format: InlineFormat,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.run(|e| e.toggle_format_view(expected, format, accept))
    }
}

/// How marked text draws until it commits, as the surface reports it.
fn marked_runs(engine: &Engine, range: DisplayRange, text: &str) -> Vec<MarkedRun> {
    engine
        .marked_runs(range, text)
        .into_iter()
        .map(|(range, formats)| MarkedRun {
            start: range.start,
            end: range.end,
            formats,
        })
        .collect()
}

/// `text` without the platform's U+FFFC placeholders at `placeholders`.
fn clean_placeholders(text: &str, placeholders: &[DisplayRange]) -> Result<String, EditorError> {
    let mut previous = 0;
    let mut result = String::new();
    for range in placeholders {
        let part = text
            .get(range.start.0..range.end.0)
            .ok_or(EditorError::InvalidRange)?;
        if range.start.0 < previous || part.is_empty() || !part.chars().all(|c| c == '\u{fffc}') {
            return Err(EditorError::InvalidRange);
        }
        result.push_str(&text[previous..range.start.0]);
        previous = range.end.0;
    }
    result.push_str(&text[previous..]);
    Ok(result)
}
