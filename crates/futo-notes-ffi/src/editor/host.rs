//! Renderer-side helpers over `futo_notes_editor::host`: no Markdown rules, only
//! coordinates a native text view needs. Shaped to be adopted unchanged by
//! Android and iOS hosts.
use std::sync::{Arc, Mutex};

use futo_notes_editor::host::{
    plan_find, plan_styles, plan_tables, toolbar_highlights, DisplayMirror, FindLanding,
    FindSnapshot, FindStepPlan, ListMarker, MirrorEdit, MirrorError, StyleSpec,
};
use futo_notes_editor::{DisplayOffset, DisplayRange, Revision};

use super::tables::EditorTableAlignment;
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
    /// How many units earlier the same insertion or deletion could equally have been spelled
    /// (see `futo_notes_editor::host::MirrorEdit::slack`); pass it to `EditorPendingEdits.record`.
    pub slack_utf16: u64,
}

impl From<MirrorEdit> for EditorMirrorEdit {
    fn from(value: MirrorEdit) -> Self {
        Self {
            start: value.start as u64,
            end: value.end as u64,
            inserted_utf16: value.inserted_utf16 as u64,
            selection_start: value.selection_start as u64,
            selection_end: value.selection_end as u64,
            slack_utf16: value.slack as u64,
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

    /// Where a render slice starting at UTF-16 unit `from` ends: after the line before the first
    /// blank line `chars` units on (so no block is cut in two), else after the next line end, else
    /// the end. Always on a scalar boundary.
    pub fn slice_end(&self, from: u64, chars: u64) -> Result<u64, EditorMirrorError> {
        let (from, chars) = (index(from)?, index(chars)?);
        Ok(self.with(|m| m.slice_end(from, chars))? as u64)
    }

    /// The UTF-16 length of `prefix` when the display starts with exactly those bytes, else nil:
    /// whether a long note's quick first screens stand as the start of the whole open.
    pub fn begins_with(&self, prefix: String) -> Option<u64> {
        self.with(|m| m.begins_with(&prefix)).map(|n| n as u64)
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

    /// Where a key replays on the engine, at the engine's caret (see
    /// `futo_notes_editor::host::DisplayMirror::at_caret`): the range the key asked for on the
    /// frozen view, relative to that view's selection, kept relative to the engine's selection.
    pub fn at_caret(
        &self,
        start: u64,
        end: u64,
        view_selection_start: u64,
        view_selection_end: u64,
        engine_selection_start: u64,
        engine_selection_end: u64,
    ) -> Result<EditorUtf16Range, EditorMirrorError> {
        let view = (index(start)?, index(end)?);
        let view_selection = (index(view_selection_start)?, index(view_selection_end)?);
        let engine_selection = (index(engine_selection_start)?, index(engine_selection_end)?);
        let (start, end) = self.with(|m| m.at_caret(view, view_selection, engine_selection));
        Ok(EditorUtf16Range {
            start: start as u64,
            end: end as u64,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorListMarker {
    Bullet,
    Ordered,
    Task,
}

/// One styled stretch of the display in UTF-16 units (see `futo_notes_editor::host::StyleSpec`).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum EditorStyleSpan {
    Inline {
        start: u64,
        end: u64,
        bold: bool,
        italic: bool,
        strike: bool,
        code: bool,
    },
    Heading {
        start: u64,
        end: u64,
        level: u8,
    },
    Quote {
        start: u64,
        end: u64,
        depth: u64,
    },
    ListRow {
        start: u64,
        end: u64,
        depth: u64,
        marker: EditorListMarker,
        number: Option<u64>,
        checked: bool,
        first: bool,
    },
    Code {
        start: u64,
        end: u64,
    },
    Metadata {
        start: u64,
        end: u64,
    },
    Link {
        start: u64,
        end: u64,
        destination: String,
    },
    Wikilink {
        start: u64,
        end: u64,
        label: String,
        note_id: Option<String>,
    },
    Divider {
        start: u64,
        end: u64,
    },
    Image {
        start: u64,
        end: u64,
        destination: String,
        alt: String,
        vault: bool,
        remote: bool,
    },
    TableRow {
        start: u64,
        end: u64,
        columns: u64,
        header: bool,
        table_start: u64,
        cells: Vec<EditorStyleCell>,
    },
    TableDelimiter {
        start: u64,
        end: u64,
    },
}

/// One cell of a table row span: its content's UTF-16 range, column and alignment.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EditorStyleCell {
    pub column: u64,
    pub start: u64,
    pub end: u64,
    pub alignment: EditorTableAlignment,
}

impl From<StyleSpec> for EditorStyleSpan {
    fn from(spec: StyleSpec) -> Self {
        let u = |v: usize| v as u64;
        match spec {
            StyleSpec::Inline {
                start,
                end,
                bold,
                italic,
                strike,
                code,
            } => Self::Inline {
                start: u(start),
                end: u(end),
                bold,
                italic,
                strike,
                code,
            },
            StyleSpec::Heading { start, end, level } => Self::Heading {
                start: u(start),
                end: u(end),
                level,
            },
            StyleSpec::Quote { start, end, depth } => Self::Quote {
                start: u(start),
                end: u(end),
                depth: u(depth),
            },
            StyleSpec::ListRow {
                start,
                end,
                depth,
                marker,
                number,
                checked,
                first,
            } => Self::ListRow {
                start: u(start),
                end: u(end),
                depth: u(depth),
                marker: match marker {
                    ListMarker::Bullet => EditorListMarker::Bullet,
                    ListMarker::Ordered => EditorListMarker::Ordered,
                    ListMarker::Task => EditorListMarker::Task,
                },
                number,
                checked,
                first,
            },
            StyleSpec::Code { start, end } => Self::Code {
                start: u(start),
                end: u(end),
            },
            StyleSpec::Metadata { start, end } => Self::Metadata {
                start: u(start),
                end: u(end),
            },
            StyleSpec::Link {
                start,
                end,
                destination,
            } => Self::Link {
                start: u(start),
                end: u(end),
                destination,
            },
            StyleSpec::Wikilink {
                start,
                end,
                label,
                note_id,
            } => Self::Wikilink {
                start: u(start),
                end: u(end),
                label,
                note_id,
            },
            StyleSpec::Divider { start, end } => Self::Divider {
                start: u(start),
                end: u(end),
            },
            StyleSpec::TableRow {
                start,
                end,
                columns,
                header,
                table_start,
                cells,
            } => Self::TableRow {
                start: u(start),
                end: u(end),
                columns: u(columns),
                header,
                table_start: u(table_start),
                cells: cells
                    .into_iter()
                    .map(|cell| EditorStyleCell {
                        column: u(cell.column),
                        start: u(cell.start),
                        end: u(cell.end),
                        alignment: cell.alignment.into(),
                    })
                    .collect(),
            },
            StyleSpec::TableDelimiter { start, end } => Self::TableDelimiter {
                start: u(start),
                end: u(end),
            },
            StyleSpec::Image {
                start,
                end,
                destination,
                alt,
                vault,
                remote,
            } => Self::Image {
                start: u(start),
                end: u(end),
                destination,
                alt,
                vault,
                remote,
            },
        }
    }
}

#[uniffi::export]
impl NativeEditorSession {
    /// The spans to draw for a display range, in UTF-16 units of the whole display. Hosts call
    /// this per window instead of converting every projection byte range themselves.
    pub fn style_plan(
        &self,
        expected: u64,
        range: EditorByteRange,
    ) -> Result<Vec<EditorStyleSpan>, EditorSessionError> {
        self.with_revision(expected, |session| {
            let display: DisplayRange = range.try_into()?;
            let slice = session.project(Revision(expected), display)?;
            let mut to_utf16 = |byte: usize| {
                let at = DisplayRange {
                    start: DisplayOffset(byte),
                    end: DisplayOffset(byte),
                };
                session
                    .display_to_utf16(Revision(expected), at)
                    .map_or(0, |r| r.start.0)
            };
            let start = to_utf16(display.start.0);
            let mut spans = plan_styles(&slice, start, &mut to_utf16);
            let tables = session.inspect_tables(Revision(expected), display)?;
            spans.extend(plan_tables(&tables, &mut to_utf16));
            Ok(spans.into_iter().map(Into::into).collect())
        })
    }

    /// The table cell holding a selection, for a host's cell editor: the cell's content range
    /// and the selection, both in UTF-16 units of the whole display (a selection leaving the
    /// cell, or outside every table, is `None`).
    pub fn cell_view(
        &self,
        expected: u64,
        selection: EditorUtf16Range,
    ) -> Result<Option<EditorCellView>, EditorSessionError> {
        self.with_revision(expected, |session| {
            let rev = Revision(expected);
            let range = session.display_from_utf16(rev, selection.try_into()?)?;
            let Some(table) = session.inspect_table(rev, range)? else {
                return Ok(None);
            };
            let Some(focus) = table.focus else {
                return Ok(None);
            };
            let Some(cell) = table
                .rows
                .get(focus.row)
                .and_then(|row| row.get(focus.column))
            else {
                return Ok(None);
            };
            let content = session.display_to_utf16(rev, cell.content)?;
            Ok(Some(EditorCellView {
                row: focus.row as u32,
                column: focus.column as u32,
                start: content.start.0 as u64,
                end: content.end.0 as u64,
            }))
        })
    }
}

/// Toolbar manifest ids to light and to dim for the current selection.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EditorToolbarHighlights {
    pub active: Vec<String>,
    pub disabled: Vec<String>,
}

#[uniffi::export]
impl NativeEditorSession {
    pub fn toolbar_highlights(&self) -> Result<EditorToolbarHighlights, EditorSessionError> {
        self.with_session(|session| {
            let h = toolbar_highlights(&session.toolbar_state());
            Ok(EditorToolbarHighlights {
                active: h.active.into_iter().map(String::from).collect(),
                disabled: h.disabled.into_iter().map(String::from).collect(),
            })
        })
    }
}

/// The cell a selection is in (see `NativeEditorSession::cell_view`).
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorCellView {
    pub row: u32,
    pub column: u32,
    pub start: u64,
    pub end: u64,
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
