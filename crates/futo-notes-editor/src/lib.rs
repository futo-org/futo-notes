//! Portable exact-source editing; persistence and views are supplied by its host.

mod backspace_length;
mod coordinates;
mod engine;
mod history;
pub mod host;
pub use history::{DisplayReplacement, DisplayUtf16Replacement, HistoryClock, InputAction};
mod lines;
mod link_target;
mod portable;
mod quick_open;
mod session;
mod table;
mod types;

pub use session::{
    BlockCommand, Composition, EditorSession, ExternalSourceAdoption, FindReport, FindScanRequest,
    FindScanResult, FindWork, MarkedRun, ParagraphKey, ToolbarCommand, ToolbarList, ToolbarState,
};
pub use table::{
    TableAlignment, TableCell, TableCommand, TableControls, TableDescription, TableFocus, TableKey,
    TableOutcome,
};
pub use types::{
    Affinity, AtomDescription, AtomKind, BlockDescription, CaretDirection, CodeBlockDescription,
    CodeBlockHeader, CodeLineDescription, CodeLineMark, Correspondence, CorrespondenceKind,
    DisplayOffset, DisplayRange, DisplayUtf16Offset, DisplayUtf16Range, EditWork, EditorError,
    ImageClaim, ImageDescription, InlineFormat, LinkDescription, ListDescription, NoteIdChange,
    NoteIdWork, ProjectionSlice, Revision, SelectionChange, SemanticRun, SourceEdit, SourceOffset,
    SourceRange, SourceUtf16Offset, SourceUtf16Range, TableBlockDescription, TableLineDescription,
    TableLineRole, ViewChange, WikilinkCandidate, WikilinkCompletion, WikilinkDescription,
};

pub use engine::is_paired_typing_key;
pub use lines::fence_info::{typed_code_block_language, typed_code_block_name};
pub use link_target::external_link_url;

pub use quick_open::{quick_open, quick_open_cut, shown_projection, QuickOpen, QUICK_OPEN_BYTES};

pub use portable::{
    Applied, HostAck, HostError, HostErrorKind, HostOperation, HostRequest, HostSnapshot,
    PortableError, PortableSession, PortableStatus, PortableTableStep, RelinkOffer, SessionToken,
};

#[cfg(target_arch = "wasm32")]
mod wasm;
