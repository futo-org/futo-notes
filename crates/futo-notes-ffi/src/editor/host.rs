//! Renderer-side helpers over `futo_notes_editor::host`: no Markdown rules, only
//! coordinates a native text view needs. Shaped to be adopted unchanged by
//! Android and iOS hosts.
use std::sync::{Arc, Mutex};

use futo_notes_editor::host::{
    plan_find, DisplayMirror, FindLanding, FindSnapshot, FindStepPlan, MirrorEdit, MirrorError,
};
use futo_notes_editor::{DisplayOffset, DisplayRange, Revision};

use super::{
    EditorByteRange, EditorFindReport, EditorSessionError, EditorUtf16Range, NativeEditorSession,
};

/// A coordinate the mirror refused; nothing changed.
#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum EditorMirrorError {
    #[error("offset outside the display text")]
    OutOfRange,
    #[error("offset splits a character")]
    SplitCharacter,
    #[error("range start is after its end")]
    Reversed,
}

impl From<MirrorError> for EditorMirrorError {
    fn from(value: MirrorError) -> Self {
        match value {
            MirrorError::OutOfRange => Self::OutOfRange,
            MirrorError::SplitCharacter => Self::SplitCharacter,
            MirrorError::Reversed => Self::Reversed,
        }
    }
}

/// One engine change in the host's UTF-16 units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EditorMirrorEdit {
    /// The replaced range of the previous display.
    pub start: u64,
    pub end: u64,
    pub inserted_utf16: u64,
    /// The resulting selection in the new display.
    pub selection_start: u64,
    pub selection_end: u64,
}

impl From<MirrorEdit> for EditorMirrorEdit {
    fn from(value: MirrorEdit) -> Self {
        Self {
            start: value.start as u64,
            end: value.end as u64,
            inserted_utf16: value.inserted_utf16 as u64,
            selection_start: value.selection_start as u64,
            selection_end: value.selection_end as u64,
        }
    }
}

fn index(value: u64) -> Result<usize, EditorMirrorError> {
    usize::try_from(value).map_err(|_| EditorMirrorError::OutOfRange)
}

/// The host's copy of the engine's display text. Apply every `EditorViewChange`
/// to it, in order; it converts the change and selection to UTF-16 so the host
/// never scans text for offsets.
#[derive(uniffi::Object)]
pub struct EditorDisplayMirror {
    inner: Mutex<DisplayMirror>,
}

impl EditorDisplayMirror {
    fn with<T>(&self, f: impl FnOnce(&mut DisplayMirror) -> T) -> T {
        f(&mut self.inner.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

#[uniffi::export]
impl EditorDisplayMirror {
    #[uniffi::constructor]
    pub fn new(display: String) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(DisplayMirror::new(&display)),
        })
    }

    pub fn reset(&self, display: String) {
        self.with(|m| m.reset(&display))
    }

    pub fn text(&self) -> String {
        self.with(|m| m.text())
    }

    pub fn utf16_len(&self) -> u64 {
        self.with(|m| m.utf16_len() as u64)
    }

    pub fn byte_len(&self) -> u64 {
        self.with(|m| m.byte_len() as u64)
    }

    pub fn byte_to_utf16(&self, byte: u64) -> Result<u64, EditorMirrorError> {
        let byte = index(byte)?;
        Ok(self.with(|m| m.byte_to_utf16(byte))? as u64)
    }

    pub fn utf16_to_byte(&self, unit: u64) -> Result<u64, EditorMirrorError> {
        let unit = index(unit)?;
        Ok(self.with(|m| m.utf16_to_byte(unit))? as u64)
    }

    pub fn slice_utf16(&self, start: u64, end: u64) -> Result<String, EditorMirrorError> {
        let (start, end) = (index(start)?, index(end)?);
        Ok(self.with(|m| m.slice_utf16(start, end))?)
    }

    /// Apply `EditorViewChange { range, inserted, selection }`.
    pub fn apply_change(
        &self,
        start: u64,
        end: u64,
        inserted: String,
        selection_start: u64,
        selection_end: u64,
    ) -> Result<EditorMirrorEdit, EditorMirrorError> {
        let (start, end) = (index(start)?, index(end)?);
        let selection = (index(selection_start)?, index(selection_end)?);
        Ok(self
            .with(|m| m.apply_change(start, end, &inserted, selection))?
            .into())
    }
}

/// One find result in UTF-16 units of the host's display, ready to paint (see `host::plan_find`).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EditorFindSnapshot {
    pub open: bool,
    pub query: String,
    pub total: u64,
    /// One-based; zero when there is no current match.
    pub current: u64,
    pub stale: bool,
    /// Ascending, non-overlapping; empty while closed, at zero, or composing.
    pub matches: Vec<EditorUtf16Range>,
    /// Set only when the call asked for a reveal: the current match, to scroll into view.
    pub reveal: Option<EditorUtf16Range>,
}

fn utf16_range((start, end): (usize, usize)) -> EditorUtf16Range {
    EditorUtf16Range {
        start: start as u64,
        end: end as u64,
    }
}

impl From<FindSnapshot> for EditorFindSnapshot {
    fn from(value: FindSnapshot) -> Self {
        Self {
            open: value.open,
            query: value.query,
            total: value.total as u64,
            current: value.current as u64,
            stale: value.stale,
            matches: value.matches.into_iter().map(utf16_range).collect(),
            reveal: value.reveal.map(utf16_range),
        }
    }
}

/// Whether a Next/Previous press has already landed on the current match since the query last
/// changed. One per find bar; `reset` when the query changes or the bar closes.
#[derive(uniffi::Object, Default)]
pub struct EditorFindLanding {
    inner: Mutex<FindLanding>,
}

#[uniffi::export]
impl EditorFindLanding {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn reset(&self) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).reset();
    }
}

/// A find press's report and the range to select and scroll to (display bytes), if it landed.
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorFindStep {
    pub report: EditorFindReport,
    pub landing: Option<EditorByteRange>,
}

#[uniffi::export]
impl NativeEditorSession {
    /// The find state as paintable UTF-16 marks. `mirror` must hold this session's display.
    /// `composing` hides the marks (they would be off by the marked text); `reveal` asks for the
    /// current match as the range to scroll to.
    pub fn find_snapshot(
        &self,
        expected: u64,
        mirror: Arc<EditorDisplayMirror>,
        composing: bool,
        reveal: bool,
    ) -> Result<EditorFindSnapshot, EditorSessionError> {
        self.with_revision(expected, |session| {
            let report = session.find_report()?;
            let matches = if report.open && report.total > 0 {
                let end = mirror.with(|m| m.byte_len());
                session.find_matches(
                    Revision(expected),
                    DisplayRange {
                        start: DisplayOffset(0),
                        end: DisplayOffset(end),
                    },
                )?
            } else {
                Vec::new()
            };
            let snapshot = mirror
                .with(|m| plan_find(&report, &matches, m, composing, reveal))
                .map_err(|_| EditorSessionError::Unavailable)?;
            Ok(snapshot.into())
        })
    }

    /// A Next/Previous press: the first one after the query changed lands on the current match,
    /// later ones step from it; during composition it only reports.
    pub fn find_step_landing(
        &self,
        expected: u64,
        landing: Arc<EditorFindLanding>,
        forward: bool,
        composing: bool,
    ) -> Result<EditorFindStep, EditorSessionError> {
        self.with_revision(expected, |session| {
            let mut landing = landing.inner.lock().unwrap_or_else(|e| e.into_inner());
            let plan = landing.plan(composing);
            let report = if plan == FindStepPlan::Advance {
                let direction = if forward {
                    futo_notes_editor::CaretDirection::Forward
                } else {
                    futo_notes_editor::CaretDirection::Backward
                };
                session.find_step(Revision(expected), direction)?
            } else {
                session.find_report()?
            };
            let range = landing.landing(plan, &report);
            Ok(EditorFindStep {
                report: report.into(),
                landing: range.map(Into::into),
            })
        })
    }
}
