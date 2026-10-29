//! Portable exact-source editing; persistence and views are supplied by its host.

mod coordinates;
mod movement;
mod portable;
mod session;
mod types;

pub use session::EditorSession;
pub use types::{
    CaretDirection, DisplayOffset, DisplayRange, DisplayUtf16Offset, DisplayUtf16Range, EditWork,
    EditorError, Revision, SelectionChange, SourceEdit, SourceOffset, SourceRange,
    SourceUtf16Offset, SourceUtf16Range, ViewChange,
};

pub use portable::{
    HostAck, HostOperation, HostRequest, HostSnapshot, PortableError, PortableSession,
    PortableStatus, SessionToken,
};

#[cfg(target_arch = "wasm32")]
mod wasm;
