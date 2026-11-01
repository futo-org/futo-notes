//! Portable exact-source editing; persistence and views are supplied by its host.

mod coordinates;
mod history;
pub use history::{DisplayReplacement, DisplayUtf16Replacement, HistoryClock, InputAction};
mod inline;
mod movement;
mod portable;
mod session;
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
    FindWork, OwnActionRelink, ParagraphKey,
};
pub use types::{
    Affinity, BlockDescription, CaretDirection, Correspondence, DisplayOffset, DisplayRange,
    DisplayUtf16Offset, DisplayUtf16Range, EditWork, EditorError, InlineFormat, LinkDescription,
    ListDescription, ProjectionSlice, Revision, SelectionChange, SemanticRun, SourceEdit,
    SourceOffset, SourceRange, SourceUtf16Offset, SourceUtf16Range, ViewChange,
};

pub use portable::{
    BoundedFrame, BoundedHostAck, BoundedHostOperation, BoundedHostRequest, BoundedModeReady,
    BoundedModeRequest, HostAck, HostOperation, HostRequest, HostSnapshot,
    PortableBoundedEntryError, PortableBoundedExitError, PortableBoundedSession, PortableError,
    PortableSession, PortableStatus, RelinkOffer, SessionToken,
};

#[cfg(target_arch = "wasm32")]
mod wasm;
