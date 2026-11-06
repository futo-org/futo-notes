//! Renderer-side helpers over `futo_notes_editor::host`: no Markdown rules, only
//! coordinates a native text view needs. Shaped to be adopted unchanged by
//! Android and iOS hosts.
use std::sync::{Arc, Mutex};

use futo_notes_editor::host::{
    plan_styles, DisplayMirror, ListMarker, MirrorEdit, MirrorError, StyleSpec,
};
use futo_notes_editor::{DisplayOffset, DisplayRange, Revision};

use super::{EditorByteRange, EditorSessionError, NativeEditorSession};

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
            Ok(plan_styles(&slice, start, &mut to_utf16)
                .into_iter()
                .map(Into::into)
                .collect())
        })
    }
}
