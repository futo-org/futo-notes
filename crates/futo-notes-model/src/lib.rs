//! `futo-notes-model` — the note domain.
//!
//! Single source of truth for deterministic note decisions: filenames, tags,
//! previews, images, IDs, and wikilinks. Durable vault behavior belongs to
//! `futo-notes-store`; this crate never reads or writes a user's note tree.
//!
//! Three runtimes consume this crate: Tauri desktop (via `#[tauri::command]`
//! wrappers), native iOS, and native Android (both via the UniFFI facade in
//! `futo-notes-ffi`). UI code is presentation only.
//!
//! Low-level primitives (`sanitize_title`, `validate_title`, path safety,
//! atomic writes, hashing) live in `futo-notes-core` and are reused here, not
//! re-ported. The rule surface is pinned bit-for-bit against the TypeScript
//! reference by the conformance fixtures in `tests/conformance/*.json`
//! (`crates/futo-notes-model/tests/conformance.rs`).

pub mod filename;
pub mod image;
pub mod note;
pub mod tags;
pub mod wikilinks;

// Re-export the title primitives reused from core so consumers have one import
// surface for "the rules" regardless of which crate implements each rule.
pub use futo_notes_core::files::{
    is_valid_title, sanitize_title, validate_title, FilenameIssue, FilenameIssueKind,
    FALLBACK_TITLE, MAX_FOLDER_DEPTH, MAX_TITLE_LENGTH,
};

pub use filename::{
    has_case_insensitive_sibling_collision, is_valid_folder_name, is_valid_folder_path,
    is_windows_reserved_name, path_depth, validate_folder_name, validate_folder_path,
};
pub use image::{is_image_filename, IMAGE_EXTENSIONS};
pub use note::{
    make_id, make_preview, make_rich_preview, note_tags, sanitize_folder_path, split_id,
    WELCOME_NOTE, WELCOME_NOTE_ID,
};
pub use tags::{
    extract_header_tag_block, extract_tags, is_valid_tag_name, normalize_tag_name, HeaderTagBlock,
    MAX_TAG_LENGTH,
};
pub use wikilinks::{
    extract_wikilinks, find_wikilinks, note_id_leaf, resolve_wikilink, rewrite_wikilinks,
    shortest_unique_suffix, WikilinkOccurrence,
};
