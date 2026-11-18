//! What a native host asks the editor to do: paragraph keys, block commands
//! and how typed input groups.
use futo_notes_editor as editor;

/// The engine determines the affected display range and paragraph semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorParagraphKey {
    Enter,
    ShiftEnter,
    Backspace,
    Delete,
    Tab,
    ShiftTab,
    BackspaceJoiningHeading,
    /// The desktop's Backspace: a heading with text never becomes text;
    /// anywhere else it is `Backspace`, which like every Backspace removes
    /// one level of an empty pair around the caret first.
    PairedBackspace,
}
impl From<EditorParagraphKey> for editor::ParagraphKey {
    fn from(value: EditorParagraphKey) -> Self {
        match value {
            EditorParagraphKey::Enter => Self::Enter,
            EditorParagraphKey::ShiftEnter => Self::ShiftEnter,
            EditorParagraphKey::Backspace => Self::Backspace,
            EditorParagraphKey::Delete => Self::Delete,
            EditorParagraphKey::Tab => Self::Tab,
            EditorParagraphKey::ShiftTab => Self::ShiftTab,
            EditorParagraphKey::BackspaceJoiningHeading => Self::BackspaceJoiningHeading,
            EditorParagraphKey::PairedBackspace => Self::PairedBackspace,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorBlockCommand {
    Heading {
        level: u8,
    },
    Quote,
    Indent,
    Outdent,
    Divider,
    BulletList,
    OrderedList,
    TaskList,
    ToggleTask,
    CodeBlock,
    WrapCodeBlock,
    ToggleHeading {
        level: u8,
    },
    OpenLineBeforeCodeBlock,
    OpenLineAfterCodeBlock,
    OpenCodeLineBelow,
    OpenCodeLineAbove,
    /// An empty table at the caret: `rows` rows, the header row included,
    /// of `columns` cells.
    Table {
        rows: u16,
        columns: u16,
    },
}
impl From<EditorBlockCommand> for editor::BlockCommand {
    fn from(value: EditorBlockCommand) -> Self {
        match value {
            EditorBlockCommand::Heading { level } => Self::Heading(level),
            EditorBlockCommand::Quote => Self::Quote,
            EditorBlockCommand::Indent => Self::Indent,
            EditorBlockCommand::Outdent => Self::Outdent,
            EditorBlockCommand::Divider => Self::Divider,
            EditorBlockCommand::BulletList => Self::BulletList,
            EditorBlockCommand::OrderedList => Self::OrderedList,
            EditorBlockCommand::TaskList => Self::TaskList,
            EditorBlockCommand::ToggleTask => Self::ToggleTask,
            EditorBlockCommand::CodeBlock => Self::CodeBlock,
            EditorBlockCommand::WrapCodeBlock => Self::WrapCodeBlock,
            EditorBlockCommand::ToggleHeading { level } => Self::ToggleHeading(level),
            EditorBlockCommand::OpenLineBeforeCodeBlock => Self::OpenLineBeforeCodeBlock,
            EditorBlockCommand::OpenLineAfterCodeBlock => Self::OpenLineAfterCodeBlock,
            EditorBlockCommand::OpenCodeLineBelow => Self::OpenCodeLineBelow,
            EditorBlockCommand::OpenCodeLineAbove => Self::OpenCodeLineAbove,
            EditorBlockCommand::Table { rows, columns } => Self::Table { rows, columns },
        }
    }
}

/// The engine owns grouping; native hosts identify isolated user actions and
/// submit only the committed text of a provisional composition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorInputAction {
    Typing,
    Isolated,
    CompositionCommit,
    /// Typing with the paired-typing conveniences (a typed backtick, `*`,
    /// `~`, `[` or `]` pairs, steps over, or formats a selection); other
    /// text is `Typing`.
    PairedTyping,
}
impl From<EditorInputAction> for editor::InputAction {
    fn from(value: EditorInputAction) -> Self {
        match value {
            EditorInputAction::Typing => Self::Typing,
            EditorInputAction::Isolated => Self::Isolated,
            EditorInputAction::CompositionCommit => Self::CompositionCommit,
            EditorInputAction::PairedTyping => Self::PairedTyping,
        }
    }
}
