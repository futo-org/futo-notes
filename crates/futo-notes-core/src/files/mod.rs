mod atomic_write;
mod blob_file;
mod filenames;
mod parked_backup;
mod paths;
mod timestamps;

pub use atomic_write::{
    create_new_atomic, rename_through_temp, write_atomic_bytes, write_atomic_text,
};
pub use blob_file::{read_blob_as_base64, write_base64_as_blob};
pub use filenames::{
    collides_but_differs, collision_key, is_valid_title, is_windows_reserved_name, sanitize_title,
    validate_title, FilenameIssue, FilenameIssueKind, FALLBACK_TITLE, MAX_TITLE_LENGTH,
};
pub use parked_backup::{recover_parked_backups, RecoveredBackup};
pub use paths::{
    classify_incoming_sync_path, ensure_safe_note_id, note_id_from_filename,
    note_id_from_relative_path, safe_appdata_path, safe_note_path, IncomingSyncPath,
    MAX_FOLDER_DEPTH, NAME_MAX,
};
pub use timestamps::{file_mtime_ms, now_ms, set_file_mtime_ms};
