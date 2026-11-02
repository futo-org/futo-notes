//! Portable exact-source editing; persistence and views are supplied by its host.

mod coordinates;
mod history;
pub use history::{DisplayReplacement, DisplayUtf16Replacement, HistoryClock, InputAction};
mod inline;
mod movement;
mod portable;
mod session;
mod table;
mod types;

pub use session::{
    BlockCommand, Composition, EditorSession, FindReport, FindScanRequest, FindScanResult,
    FindWork, OwnActionRelink, ParagraphKey,
};
pub use table::{
    TableAlignment, TableCell, TableCommand, TableControls, TableDescription, TableFocus, TableKey,
    TableOutcome,
};
pub use types::{
    Affinity, AtomDescription, AtomKind, BlockDescription, CaretDirection, Correspondence,
    DisplayOffset, DisplayRange, DisplayUtf16Offset, DisplayUtf16Range, EditWork, EditorError,
    ImageClaim, ImageDescription, InlineFormat, LinkDescription, ListDescription, NoteIdChange,
    NoteIdWork, ProjectionSlice, Revision, SelectionChange, SemanticRun, SourceEdit, SourceOffset,
    SourceRange, SourceUtf16Offset, SourceUtf16Range, ViewChange, WikilinkCandidate,
    WikilinkCompletion, WikilinkDescription,
};

pub use portable::{
    HostAck, HostOperation, HostRequest, HostSnapshot, PortableError, PortableSession,
    PortableStatus, PortableTableStep, RelinkOffer, SessionToken,
};

#[cfg(target_arch = "wasm32")]
mod wasm;
