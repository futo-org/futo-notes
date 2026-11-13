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
    BackspaceJoiningHeading,
    Delete,
    Tab,
    ShiftTab,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolbarList {
    Bullet,
    Ordered,
    Task,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolbarState {
    pub formats: Vec<InlineFormat>,
    pub heading: Option<u8>,
    pub quote: bool,
    pub list: Option<ToolbarList>,
    pub code: bool,
    pub mixed: bool,
    pub inline_allowed: bool,
    pub can_indent: bool,
    pub can_outdent: bool,
    pub can_undo: bool,
    pub can_redo: bool,
}
