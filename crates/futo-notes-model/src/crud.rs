//! Note + folder CRUD and scanning. The canonical implementation of the note
//! domain that the iOS `NotesStore`, Android, and Tauri shells all delegate to.
//!
//! Reuses `core::files` for path safety, atomic writes, mtime handling, and
//! unique-id collision — this module does not re-port those. It ports the
//! spike's `NotesStore.swift` behavior (scan/sort/preview/folders/CRUD) so the
//! Swift becomes a thin reactive shell.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use futo_notes_core::files::{
    file_mtime_ms, get_unique_note_id, rename_through_temp, safe_note_path, sanitize_title,
    write_atomic_text,
};
use futo_notes_core::sync::collides_but_differs;
use rayon::prelude::*;

/// One note's list-level metadata. Mirrors the Swift `NoteItem`:
/// `id` is the path relative to the notes root WITHOUT `.md`; `title` is the
/// filename leaf verbatim; `tags` are canonical lowercase names WITHOUT the
/// leading `#` (display/search only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteMetadata {
    pub id: String,
    pub title: String,
    pub folder: String,
    /// File modification time, ms since Unix epoch.
    pub modified_ms: i64,
    pub preview: String,
    pub tags: Vec<String>,
}

// ── Rules layered on the deterministic primitives ────────────────────────

/// Split a note id into `(folder, title-leaf)`. Mirrors `NotesStore.split`.
pub fn split_id(id: &str) -> (String, String) {
    match id.rfind('/') {
        Some(idx) => (id[..idx].to_string(), id[idx + 1..].to_string()),
        None => (String::new(), id.to_string()),
    }
}

/// Sanitize a folder path component-by-component, dropping empty segments.
/// `"Specs//Drafts "` → `"Specs/Drafts"`. Mirrors `NotesStore.sanitizeFolderPath`.
pub fn sanitize_folder_path(raw: &str) -> String {
    raw.split('/')
        .filter(|c| !c.is_empty())
        .map(sanitize_title)
        .collect::<Vec<_>>()
        .join("/")
}

/// Compose a note id from a folder + title, sanitizing both. Mirrors
/// `NotesStore.makeId`. Note: unlike the old Swift `sanitizeTitle`, the
/// canonical `sanitize_title` does NOT truncate to 200 chars.
pub fn make_id(folder: &str, title: &str) -> String {
    let clean_title = sanitize_title(title);
    let folder_clean = sanitize_folder_path(folder);
    if folder_clean.is_empty() {
        clean_title
    } else {
        format!("{folder_clean}/{clean_title}")
    }
}

/// Canonical tag names for a note's content, WITHOUT the leading `#`
/// (display/search form used by `NoteMetadata.tags`). Same rule as the
/// canonical `extract_tags` (which returns `#tag`), but emits the bare names
/// directly instead of allocating `#tag` strings and stripping the prefix back
/// off — a per-tag allocation saved on every scanned note.
pub fn note_tags(content: &str) -> Vec<String> {
    crate::tags::extract_tag_names(content)
}

/// Maximum preview length in Unicode scalar values (code points). Matches the
/// canonical TS `PREVIEW_MAX_CHARS` (`packages/editor/src/preview.ts`).
const PREVIEW_MAX_CHARS: usize = 100;

/// ~100-char preview with CR/LF/TAB collapsed to single spaces, then trimmed.
/// This is the single source of truth for the preview rule; the TS
/// `makePreview()` and Swift `NotesStore.makePreview` are kept identical to it
/// (the TS copy is conformance-locked — see `tests/conformance/preview.json`).
/// Runs of regular spaces are preserved — only CR/LF/TAB collapse.
///
/// Behaviour is byte-for-byte identical to the reference
/// `content.replace("\r\n"," ").replace('\n'," ").replace('\t'," ").trim().chars().take(100)`
/// but in a SINGLE pass with no full-body allocations and early-out once the
/// 100-code-point budget is reached — so a multi-MB note costs O(prefix), not
/// three full-body copies. The reference order is `collapse → trim → take`, so
/// trailing whitespace is removed from the WHOLE collapsed string BEFORE the
/// 100-char cut; this implementation reproduces that exactly (see the unit
/// tests in `tests/scan_perf.rs` for the truncation×trim boundary cases).
pub fn make_preview(content: &str) -> String {
    // Conceptually transform `content` into the "collapsed" char stream:
    //   "\r\n" → ' ', '\n' → ' ', '\t' → ' ', everything else unchanged
    //   (a bare '\r' is left as-is, like the reference).
    // We then take the trimmed first 100 code points without materializing the
    // full collapsed string.
    let mut out = String::new();
    let mut committed = 0usize;
    let mut started = false; // have we passed the leading-trim whitespace?
    let mut saw_content_past_limit = false;

    let mut chars = content.chars().peekable();
    while let Some(c) = chars.next() {
        // Collapse step (matches replace order: CRLF before bare LF).
        let mapped = match c {
            '\r' if chars.peek() == Some(&'\n') => {
                chars.next(); // consume the '\n' of the CRLF
                ' '
            }
            '\n' | '\t' => ' ',
            other => other,
        };

        if !started {
            // Leading trim: skip whitespace until the first non-whitespace
            // mapped char (`char::is_whitespace` matches `str::trim`).
            if mapped.is_whitespace() {
                continue;
            }
            started = true;
        }

        if committed < PREVIEW_MAX_CHARS {
            out.push(mapped);
            committed += 1;
        } else {
            // Budget reached. The only thing left to decide is whether the
            // collapsed-trimmed string was LONGER than 100 code points (i.e. a
            // non-whitespace char follows) — if so, trailing whitespace inside
            // the first 100 is internal and must be kept; otherwise the tail is
            // all whitespace and `trim()` would have dropped it.
            if !mapped.is_whitespace() {
                saw_content_past_limit = true;
                break;
            }
            // Pathological all-whitespace tail: keep scanning (rare).
        }
    }

    // Trailing trim applies only when the collapsed-trimmed string is <= 100
    // code points (we exhausted content under budget, or the tail past the
    // budget was pure whitespace). When real content followed the budget, the
    // first 100 code points are returned verbatim.
    if !saw_content_past_limit {
        let trimmed_len = out.trim_end().len();
        out.truncate(trimmed_len);
    }
    out
}

// ── Scanning ─────────────────────────────────────────────────────────────

/// Recursively scan `.md` files under `base`, skipping hidden entries, and
/// return list metadata sorted by mtime descending (ties broken by id ascending
/// for determinism — the Swift sort was unstable on ties). Mirrors
/// `NotesStore.reload`'s note half.
pub fn scan_notes(base: &Path) -> Vec<NoteMetadata> {
    let mut files = Vec::new();
    if base.exists() {
        collect_md_files(base, base, &mut files);
    }
    // The per-file work (read + UTF-8 decode + preview + tag extraction) is the
    // dominant per-note cost and is fully independent across files, so it runs
    // in parallel (rayon). The directory walk above stays serial — it's cheap
    // and ordering is irrelevant because the explicit sort below is the only
    // thing that fixes output order. The sort key `(modified_ms desc, id asc)`
    // is total and deterministic, so the result is identical to a serial scan
    // regardless of how the parallel work is scheduled.
    let mut out: Vec<NoteMetadata> = files
        .into_par_iter()
        .filter_map(|(rel_id, path)| {
            let meta = std::fs::metadata(&path).ok()?;
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            let (folder, title) = split_id(&rel_id);
            Some(NoteMetadata {
                id: rel_id,
                title,
                folder,
                modified_ms: file_mtime_ms(&meta),
                preview: make_preview(&content),
                tags: note_tags(&content),
            })
        })
        .collect();
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then(a.id.cmp(&b.id)));
    out
}

/// All folder paths relative to `base`: every folder implied by a note id
/// (plus ancestors) and every empty folder that exists on disk (plus
/// ancestors). Sorted lexicographically; `""` (root) excluded. Mirrors
/// `NotesStore.reload`'s folder half (`registerAncestors` + `scanDirs`).
pub fn scan_folders(base: &Path) -> Vec<String> {
    let mut set: BTreeSet<String> = BTreeSet::new();
    if base.exists() {
        let mut files = Vec::new();
        collect_md_files(base, base, &mut files);
        for (rel_id, _) in &files {
            let (folder, _) = split_id(rel_id);
            register_ancestors(&folder, &mut set);
        }
        let mut dirs = Vec::new();
        collect_dirs(base, base, &mut dirs);
        for rel in dirs {
            register_ancestors(&rel, &mut set);
        }
    }
    set.into_iter().collect()
}

/// Insert `path` and every ancestor folder into `set` (`""` ignored).
fn register_ancestors(path: &str, set: &mut BTreeSet<String>) {
    if path.is_empty() {
        return;
    }
    let mut acc = String::new();
    for part in path.split('/').filter(|p| !p.is_empty()) {
        if acc.is_empty() {
            acc = part.to_string();
        } else {
            acc.push('/');
            acc.push_str(part);
        }
        set.insert(acc.clone());
    }
}

/// Recursively collect `(rel_id, abs_path)` for `.md` files, skipping hidden
/// entries (names starting with `.`).
fn collect_md_files(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            collect_md_files(base, &path, out);
        } else if ft.is_file() && name.ends_with(".md") {
            if let Ok(rel) = path.strip_prefix(base) {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if let Some(id) = rel_str.strip_suffix(".md") {
                    if !id.is_empty() {
                        out.push((id.to_string(), path.clone()));
                    }
                }
            }
        }
    }
}

/// Recursively collect relative paths of all directories under `base`,
/// skipping hidden ones.
fn collect_dirs(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Ok(rel) = path.strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
            collect_dirs(base, &path, out);
        }
    }
}

// ── CRUD ─────────────────────────────────────────────────────────────────

/// Read a note's content. Returns `""` for a missing/unreadable note
/// (matches the Swift `?? ""`).
pub fn read_note(base: &Path, id: &str) -> String {
    match safe_note_path(base, id) {
        Ok(path) => std::fs::read_to_string(path).unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// Whether a note file currently exists on disk.
pub fn note_exists(base: &Path, id: &str) -> bool {
    match safe_note_path(base, id) {
        Ok(path) => path.exists(),
        Err(_) => false,
    }
}

/// Atomically write `content` to the note at `id`, creating parent folders.
pub fn write_note(base: &Path, id: &str, content: &str) -> Result<(), String> {
    let path = safe_note_path(base, id)?;
    write_atomic_text(&path, content)
}

/// Create a new note from a title (+ optional folder). Returns the final,
/// collision-resolved id. Mirrors `NotesStore.createNote`.
pub fn create_note(base: &Path, folder: &str, title: &str) -> Result<String, String> {
    let wanted = make_id(folder, title);
    let id = get_unique_note_id(base, &wanted, None)?;
    write_note(base, &id, "")?;
    Ok(id)
}

/// Delete a note. Missing file is not an error. Empty parent folders are NOT
/// pruned (they surface as empty folders, matching the Swift behavior).
pub fn delete_note(base: &Path, id: &str) -> Result<(), String> {
    let path = safe_note_path(base, id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Rename/move a note from `old_id` to `new_id` (collision-resolved). Returns
/// the final id. No-op (returns `old_id`) when they're equal. Mirrors
/// `NotesStore.rename`.
pub fn rename_note(base: &Path, old_id: &str, new_id: &str) -> Result<String, String> {
    if old_id == new_id {
        return Ok(old_id.to_string());
    }

    // F3: a case-only / NFC-vs-NFD rename (e.g. `note` → `Note`, or `café`
    // composed → decomposed). On a case/normalization-insensitive filesystem
    // (default APFS on macOS/iOS, NTFS on Windows) the source and dest resolve
    // to the SAME directory entry, so:
    //   1. `get_unique_note_id(base, new_id, None)` sees the dest as occupied
    //      (its `.exists()` probe matches the existing case-variant) and bumps
    //      to `new_id-2`, silently losing the requested capitalization; and
    //   2. a plain `fs::rename(src, dst)` is a kernel no-op that never rewrites
    //      the stored bytes.
    // Route these through a temp hop instead. We do NOT run
    // `get_unique_note_id` here: its `.exists()` probe (and its exact-string
    // `exclude`) is case-sensitive, so on APFS it would still see `new_id` as
    // occupied by the case-variant `old_id` and bump to `new_id-2`. Because the
    // collision is exclusively with `old_id` (which is being renamed away), the
    // requested `new_id` is the correct, final id.
    if collides_but_differs(old_id, new_id) {
        let src = safe_note_path(base, old_id)?;
        let dst = safe_note_path(base, new_id)?;
        rename_through_temp(&src, &dst)?;
        return Ok(new_id.to_string());
    }

    let final_id = get_unique_note_id(base, new_id, None)?;
    let src = safe_note_path(base, old_id)?;
    let dst = safe_note_path(base, &final_id)?;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(final_id)
}

/// Move a note into `folder` (`""` = root), keeping its title leaf. Returns
/// the final id. Mirrors `NotesStore.moveNote`.
pub fn move_note(base: &Path, id: &str, folder: &str) -> Result<String, String> {
    let (_, leaf) = split_id(id);
    let clean_folder = sanitize_folder_path(folder);
    let new_id = if clean_folder.is_empty() {
        leaf
    } else {
        format!("{clean_folder}/{leaf}")
    };
    if new_id == id {
        return Ok(id.to_string());
    }
    rename_note(base, id, &new_id)
}

/// Create a folder (and missing intermediates) on disk. Returns the sanitized
/// path actually created, or `""` for an effectively-empty input (no-op).
/// Mirrors `NotesStore.createFolder`.
pub fn create_folder(base: &Path, path: &str) -> Result<String, String> {
    let clean = sanitize_folder_path(path);
    if clean.is_empty() {
        return Ok(String::new());
    }
    // Each component is already sanitized; build the path safely.
    let mut abs = base.to_path_buf();
    for component in clean.split('/') {
        abs.push(component);
    }
    std::fs::create_dir_all(&abs).map_err(|e| e.to_string())?;
    Ok(clean)
}

/// Delete a folder and ALL its contents (notes + subfolders), recursively.
/// `path` is a folder path relative to `base`. A missing folder is NOT an error
/// (mirrors `delete_note`). Returns `Err` only on a genuine I/O failure or an
/// unsafe path. Refuses to delete the notes root (`""`).
///
/// Sync: this removes note files from disk but does NOT itself touch the sync
/// object map. The next push diffs disk vs the persisted map and tombstones
/// every removed note on the server (see `orchestrator::pair_local_moved` /
/// the push delta) — exactly how a single-note `delete_note` propagates. So the
/// caller should trigger a reload + the local-change/auto-push signal after.
pub fn delete_folder(base: &Path, path: &str) -> Result<(), String> {
    let clean = sanitize_folder_path(path);
    if clean.is_empty() {
        return Err("refusing to delete the notes root".to_string());
    }
    // `sanitize_folder_path` preserves dots, so a literal `.`/`..` segment could
    // survive — and `PathBuf::starts_with` is purely lexical (it would accept
    // `base/..`). Reject traversal explicitly before building the path. This is
    // a destructive, recursive op, so be conservative.
    if clean.split('/').any(|c| c == "." || c == "..") {
        return Err("path traversal blocked".to_string());
    }
    let mut abs = base.to_path_buf();
    for component in clean.split('/') {
        abs.push(component);
    }
    match std::fs::remove_dir_all(&abs) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
