mod localization;
mod notes;
mod sync;

pub use localization::{localization_maximize_language_tag, localization_plural_category};
pub use notes::{
    extract_tags, extract_wikilinks, image_extensions, make_id, make_preview, make_rich_preview,
    sanitize_title, split_id, validate_title, FlushDisposition, FlushDraftResult, NoteBootstrap,
    NoteError, NoteIdParts, NoteMetadata, NoteMutation, NoteSnapshot, NoteStore, SearchHit,
    TitleIssue, UpsertedNote,
};
pub use sync::{
    classify_open_note, hosted_server_url, min_vault_password_length, probe_sign_in_flow,
    BillingStatus, Checkout, ConnectInfo, EntitlementOutcome, HostedError, HostedSession,
    HostedSetupClient, KeepDraftReason, OpenNoteDisposition, OpenNoteFacts, RenamePair,
    SecretStoreError, SetupStep, SignInFlow, SignInHandoff, SignInOutcome, SyncClient, SyncError,
    SyncEventListener, SyncFailure, SyncStatus, SyncSummary, VaultSecretStore, WriteRefusal,
};

uniffi::setup_scaffolding!();
