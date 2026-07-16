mod notes;
mod sync;

pub use notes::{
    extract_tags, extract_wikilinks, image_extensions, make_id, make_preview, make_rich_preview,
    sanitize_title, split_id, validate_title, ConditionalWrite, CreateOutcome, FlushOutcome,
    NoteBootstrap, NoteError, NoteIdParts, NoteMetadata, NoteMutation, NoteRename, NoteSnapshot,
    NoteStore, SearchHit, TitleIssue,
};
pub use sync::{
    ConnectInfo, SyncClient, SyncError, SyncEventListener, SyncFailure, SyncStatus, SyncSummary,
};

uniffi::setup_scaffolding!();
