//! Portable exact-source editing; persistence and views are supplied by its host.

/// Under the `engine` feature (never in a shipping build) a method on the
/// editing path runs on the rebuilt core instead (`src/session/next.rs`).
/// `ref` borrows the core; `accept` passes the method's acceptance through.
macro_rules! on_next {
    (ref $session:ident, |$engine:ident| $body:expr) => {
        #[cfg(feature = "engine")]
        {
            if let Some($engine) = $session.next.as_deref() {
                return $body;
            }
        }
    };
    ($session:ident, |$engine:ident| $body:expr) => {
        #[cfg(feature = "engine")]
        {
            if $session.next.is_some() {
                return $session.with_next(|$engine| $body);
            }
        }
    };
    ($session:ident, $accept:ident, |$engine:ident, $inner:ident| $body:expr) => {
        #[cfg(feature = "engine")]
        {
            if $session.next.is_some() {
                return $session.with_next_accept($accept, |$engine, $inner| $body);
            }
        }
    };
    ($session:ident, nothing) => {
        #[cfg(feature = "engine")]
        {
            if $session.next.is_some() {
                return crate::session::not_yet();
            }
        }
    };
}

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
