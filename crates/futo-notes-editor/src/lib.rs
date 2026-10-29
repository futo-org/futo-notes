//! Portable exact-source editing; persistence and views are supplied by its host.

mod coordinates;
mod inline;
mod movement;
mod session;
mod types;

pub use session::EditorSession;
pub use types::{
    Affinity, CaretDirection, Correspondence, DisplayOffset, DisplayRange, DisplayUtf16Offset,
    DisplayUtf16Range, EditWork, EditorError, InlineFormat, ProjectionSlice, Revision,
    SelectionChange, SemanticRun, SourceEdit, SourceOffset, SourceRange, SourceUtf16Offset,
    SourceUtf16Range, ViewChange,
};
