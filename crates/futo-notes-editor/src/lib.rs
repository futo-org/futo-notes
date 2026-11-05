//! Portable exact-source editing; persistence and views are supplied by its host.

mod coordinates;
mod history;
pub use history::{DisplayReplacement, DisplayUtf16Replacement, HistoryClock, InputAction};
mod inline;
mod movement;
mod parallel;
mod portable;
mod session;
mod table;
mod types;

pub use session::{
    BlockCommand, Composition, EditorSession, ExternalSourceAdoption, FindReport, FindScanRequest,
    FindScanResult, FindWork, MarkedRun, ParagraphKey, ToolbarList, ToolbarState,
};
pub use table::{
    TableAlignment, TableCell, TableCommand, TableControls, TableDescription, TableFocus, TableKey,
    TableOutcome,
};
pub use types::{
    Affinity, AtomDescription, AtomKind, BlockDescription, CaretDirection, Correspondence,
    CorrespondenceKind, DisplayOffset, DisplayRange, DisplayUtf16Offset, DisplayUtf16Range,
    EditWork, EditorError, ImageClaim, ImageDescription, InlineFormat, LinkDescription,
    ListDescription, NoteIdChange, NoteIdWork, ProjectionSlice, Revision, SelectionChange,
    SemanticRun, SourceEdit, SourceOffset, SourceRange, SourceUtf16Offset, SourceUtf16Range,
    ViewChange, WikilinkCandidate, WikilinkCompletion, WikilinkDescription,
};

pub use portable::{
    Applied, HostAck, HostError, HostErrorKind, HostOperation, HostRequest, HostSnapshot,
    PortableError, PortableSession, PortableStatus, PortableTableStep, RelinkOffer, SessionToken,
};

#[cfg(target_arch = "wasm32")]
mod wasm;
