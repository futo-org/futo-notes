//! Portable exact-source editing; persistence and views are supplied by its host.

mod coordinates;
mod movement;
mod session;
mod types;

pub use session::EditorSession;
pub use types::{
    CaretDirection, DisplayOffset, DisplayRange, DisplayUtf16Offset, DisplayUtf16Range, EditWork,
    EditorError, Revision, SelectionChange, SourceEdit, SourceOffset, SourceRange,
    SourceUtf16Offset, SourceUtf16Range, ViewChange,
};
