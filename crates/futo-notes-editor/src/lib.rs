//! Portable exact-source editing; persistence and views are supplied by its host.

mod coordinates;
mod engine;
mod history;
pub mod host;
pub use history::{DisplayReplacement, DisplayUtf16Replacement, HistoryClock, InputAction};
mod inline;
mod lines;
mod link_target;
mod movement;
mod parallel;
mod portable;
mod quick_open;
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

pub use link_target::external_link_url;

pub use quick_open::{
    may_define_reference, quick_open, quick_open_cut, shown_projection, QuickOpen, QUICK_OPEN_BYTES,
};

pub use portable::{
    Applied, HostAck, HostError, HostErrorKind, HostOperation, HostRequest, HostSnapshot,
    PortableError, PortableSession, PortableStatus, PortableTableStep, RelinkOffer, SessionToken,
};

#[cfg(target_arch = "wasm32")]
mod wasm;
