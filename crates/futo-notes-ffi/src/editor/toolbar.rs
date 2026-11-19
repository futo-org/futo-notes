//! Selection state is one thin query of the canonical editor, on its worker.
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorToolbarList {
    Bullet,
    Ordered,
    Task,
}

/// A command a toolbar offers (`EditorToolbarSnapshot::allowed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorToolbarCommand {
    Bold,
    Italic,
    Strike,
    Code,
    Link,
    /// The heading toggle, at every level alike.
    Heading,
    Quote,
    BulletList,
    OrderedList,
    TaskList,
    CodeBlock,
    Divider,
    Table,
    /// `insert_image` at the selection.
    Image,
}

impl From<futo_notes_editor::ToolbarCommand> for EditorToolbarCommand {
    fn from(command: futo_notes_editor::ToolbarCommand) -> Self {
        use futo_notes_editor::ToolbarCommand;
        match command {
            ToolbarCommand::Bold => Self::Bold,
            ToolbarCommand::Italic => Self::Italic,
            ToolbarCommand::Strike => Self::Strike,
            ToolbarCommand::Code => Self::Code,
            ToolbarCommand::Link => Self::Link,
            ToolbarCommand::Heading => Self::Heading,
            ToolbarCommand::Quote => Self::Quote,
            ToolbarCommand::BulletList => Self::BulletList,
            ToolbarCommand::OrderedList => Self::OrderedList,
            ToolbarCommand::TaskList => Self::TaskList,
            ToolbarCommand::CodeBlock => Self::CodeBlock,
            ToolbarCommand::Divider => Self::Divider,
            ToolbarCommand::Table => Self::Table,
            ToolbarCommand::Image => Self::Image,
        }
    }
}

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorToolbarSnapshot {
    pub formats: Vec<EditorInlineFormat>,
    pub heading: Option<u8>,
    pub quote: bool,
    pub list: Option<EditorToolbarList>,
    pub code: bool,
    pub mixed: bool,
    pub inline_allowed: bool,
    pub can_indent: bool,
    pub can_outdent: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    /// The commands that would act at the selection now; a button whose
    /// command is left out would change nothing.
    pub allowed: Vec<EditorToolbarCommand>,
}

impl From<futo_notes_editor::ToolbarState> for EditorToolbarSnapshot {
    fn from(state: futo_notes_editor::ToolbarState) -> Self {
        Self {
            formats: state.formats.into_iter().map(Into::into).collect(),
            heading: state.heading,
            quote: state.quote,
            list: state.list.map(|list| match list {
                futo_notes_editor::ToolbarList::Bullet => EditorToolbarList::Bullet,
                futo_notes_editor::ToolbarList::Ordered => EditorToolbarList::Ordered,
                futo_notes_editor::ToolbarList::Task => EditorToolbarList::Task,
            }),
            code: state.code,
            mixed: state.mixed,
            inline_allowed: state.inline_allowed,
            can_indent: state.can_indent,
            can_outdent: state.can_outdent,
            can_undo: state.can_undo,
            can_redo: state.can_redo,
            allowed: state.allowed.into_iter().map(Into::into).collect(),
        }
    }
}

#[uniffi::export]
impl NativeEditorSession {
    pub fn toolbar_state(&self) -> Result<EditorToolbarSnapshot, EditorSessionError> {
        self.with_session(|session| Ok(session.toolbar_state().into()))
    }
}
