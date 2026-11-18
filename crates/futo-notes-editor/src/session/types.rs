//! Values the session's methods take and return.
use crate::{DisplayRange, InlineFormat, Revision};
use serde::{Deserialize, Serialize};

/// Views draw this overlay without interpreting markdown. Its range always
/// addresses committed display text, never the provisional string's offsets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Composition {
    pub revision: Revision,
    pub range: DisplayRange,
    pub text: String,
    /// The inline formats the marked text will have once committed, so a view
    /// draws it that way while it is still provisional. Characters no run
    /// covers are plain.
    #[serde(default)]
    pub runs: Vec<MarkedRun>,
}

/// One formatted stretch of marked text, in byte offsets into `Composition::text`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkedRun {
    pub start: usize,
    pub end: usize,
    pub formats: Vec<InlineFormat>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParagraphKey {
    Enter,
    ShiftEnter,
    Backspace,
    /// Text-first heading-start deletion joins the preceding physical line.
    /// Like every Backspace, it removes one level of an empty pair first.
    BackspaceJoiningHeading,
    Delete,
    Tab,
    ShiftTab,
    /// Ctrl+T on Apple (AppKit's `transpose:`).
    Transpose,
    /// The desktop's Backspace: at a heading's text start it joins the line
    /// above and never makes a heading with text into text; anywhere else it
    /// is `Backspace` (which, like every Backspace, removes one level of an
    /// empty pair first).
    PairedBackspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlockCommand {
    /// Zero selects plain paragraph text; one through six select a heading.
    Heading(u8),
    /// Text-first toolbar: selecting the common current level restores Text.
    ToggleHeading(u8),
    Quote,
    Indent,
    Outdent,
    Divider,
    ToggleTask,
    BulletList,
    OrderedList,
    TaskList,
    CodeBlock,
    /// Text-first toolbar: one fence around all selected physical lines.
    WrapCodeBlock,
    /// An empty line before the code block the range starts in, the caret on
    /// it: where no line borders the block (it starts the note).
    OpenLineBeforeCodeBlock,
    /// An empty line after the code block the range starts in, closing it
    /// first when nothing closes it.
    OpenLineAfterCodeBlock,
    /// A new code line below the code line the range ends on, the caret on
    /// it, at the indent Enter at that line's end writes.
    OpenCodeLineBelow,
    /// A new code line above the code line the range starts on, the caret
    /// on it, at that line's indent.
    OpenCodeLineAbove,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ToolbarList {
    Bullet,
    Ordered,
    Task,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolbarState {
    pub formats: Vec<InlineFormat>,
    pub heading: Option<u8>,
    /// Whether a heading command can change a touched line: false over
    /// lines no heading applies to (table lines, code, dividers).
    pub heading_allowed: bool,
    pub quote: bool,
    /// Whether Quote can change a touched line: false over lines it never
    /// changes (table lines, code, dividers).
    pub quote_allowed: bool,
    pub list: Option<ToolbarList>,
    pub code: bool,
    pub mixed: bool,
    pub inline_allowed: bool,
    pub can_indent: bool,
    pub can_outdent: bool,
    pub can_undo: bool,
    pub can_redo: bool,
}
