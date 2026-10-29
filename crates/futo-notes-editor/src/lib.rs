//! Portable exact-source editing; persistence and views are supplied by its host.

mod session;
mod types;

pub use session::EditorSession;
pub use types::{
    DisplayOffset, DisplayRange, EditWork, EditorError, Revision, SourceEdit, SourceOffset,
    SourceRange, ViewChange,
};
