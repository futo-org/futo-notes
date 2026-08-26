mod localization;
mod notes;
mod sync;

pub use localization::{localization_maximize_language_tag, localization_plural_category};
pub use notes::{
    extract_tags, extract_wikilinks, image_extensions, make_id, make_preview, make_rich_preview,
    sanitize_title, split_id, validate_title, ConditionalWrite, CreateOutcome, FlushDisposition,
    FlushDraftResult, FlushOutcome, NoteBootstrap, NoteError, NoteIdParts, NoteMetadata,
    NoteMutation, NoteSnapshot, NoteStore, SearchHit, TitleIssue, UpsertedNote,
};
pub use sync::{
    classify_open_note, ConnectInfo, KeepDraftReason, OpenNoteDisposition, OpenNoteFacts,
    RenamePair, SyncClient, SyncError, SyncEventListener, SyncFailure, SyncStatus, SyncSummary,
};

uniffi::setup_scaffolding!();
