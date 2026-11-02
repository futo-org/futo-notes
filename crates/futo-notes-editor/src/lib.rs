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

pub use session::bounded::{
    BoundedBlock, BoundedChange, BoundedCodeProjection, BoundedCursor, BoundedEditorSession,
    BoundedEntryError, BoundedError, BoundedMap, BoundedMapKind, BoundedMeaning, BoundedProgress,
    BoundedProgressChange, BoundedProgressStatus, BoundedSourceAuthority, BoundedSourceChange,
    BoundedSourceOperation, BoundedSourceSession, BoundedWork, CodeFragment, CodeIdentity,
    ProjectionContinuation,
};
pub use session::{
    BlockCommand, Composition, EditorSession, FindReport, FindScanRequest, FindScanResult,
    FindWork, ParagraphKey,
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
    BoundedFrame, BoundedHostAck, BoundedHostOperation, BoundedHostRequest, BoundedModeReady,
    BoundedModeRequest, HostAck, HostOperation, HostRequest, HostSnapshot,
    PortableBoundedEntryError, PortableBoundedExitError, PortableBoundedSession, PortableError,
    PortableSession, PortableStatus, PortableTableStep, RelinkOffer, SessionToken,
};

#[cfg(target_arch = "wasm32")]
mod wasm;
