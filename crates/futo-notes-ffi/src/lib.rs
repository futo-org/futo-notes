mod license;
mod localization;
mod notes;
mod sync;

pub use license::{
    license_app_store_product_id, license_deep_link_scheme, license_enter_key, license_evaluate,
    license_evidence_includes, license_evidence_row_actions, license_handle_deep_link,
    license_includes, license_link_out, license_links, license_plate, license_purchase_surface,
    license_row_actions, license_surface_row_actions, BuySource, LicenseAcceptance, LicenseAction,
    LicenseDistribution, LicenseError, LicenseEvidence, LicenseInclusion, LicenseLinkOutcome,
    LicenseLinks, LicensePair, LicensePlate, LicensePlatform, LicensePurchaseSurface,
    LicenseStatus, LicenseView,
};
pub use localization::{localization_maximize_language_tag, localization_plural_category};
pub use notes::{
    extract_tags, extract_wikilinks, image_extensions, make_id, make_preview, make_rich_preview,
    sanitize_title, split_id, validate_title, FlushDisposition, FlushDraftResult, NoteBootstrap,
    NoteError, NoteIdParts, NoteMetadata, NoteMutation, NoteSnapshot, NoteSortKey, NoteSortOrder,
    NoteStore, SearchHit, SortDirection, TitleIssue, UpsertedNote,
};
pub use sync::{
    classify_open_note, min_vault_password_length, probe_sign_in_flow, BillingStatus, Checkout,
    ConnectInfo, EntitlementOutcome, HostedError, HostedSession, HostedSetupClient,
    KeepDraftReason, OpenNoteDisposition, OpenNoteFacts, RenamePair, SecretStoreError, SetupStep,
    SignInFlow, SignInHandoff, SignInOutcome, SyncClient, SyncError, SyncEventListener,
    SyncFailure, SyncStatus, SyncSummary, VaultSecretStore, WriteRefusal,
};

uniffi::setup_scaffolding!();
