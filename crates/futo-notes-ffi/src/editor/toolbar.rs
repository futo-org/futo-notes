//! Selection state is one thin query of the canonical editor, on its worker.
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorToolbarList {
    Bullet,
    Ordered,
    Task,
}

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorToolbarState {
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
}

impl From<futo_notes_editor::ToolbarState> for EditorToolbarState {
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
        }
    }
}

#[uniffi::export]
impl NativeEditorSession {
    pub fn toolbar_state(&self) -> Result<EditorToolbarState, EditorSessionError> {
        self.with_session(|session| Ok(session.toolbar_state().into()))
    }
}
