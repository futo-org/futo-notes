use base64::{engine::general_purpose::STANDARD, Engine as _};
use filetime::{set_file_mtime, FileTime};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Process-wide monotonic counter for unique temp-file names. `now_ms()` alone
/// collides when two atomic writes land in the same millisecond in the same
/// directory (common during an initial sync's apply loop), which can surface as
/// spurious rename failures. Combining it with this counter makes the temp name
/// unique per call across all threads/tasks.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

// ── Constants ───────────────────────────────────────────────────────────

/// Maximum title length (characters, before .md extension).
pub const MAX_TITLE_LENGTH: usize = 200;

/// Fallback title when input is empty or all-invalid.
pub const FALLBACK_TITLE: &str = "Untitled";

// ── Types ───────────────────────────────────────────────────────────────

/// Mirrors TypeScript `FilenameIssueKind` from `packages/shared/src/filename.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilenameIssueKind {
    ForbiddenChars,
    LeadingDots,
    TrailingDots,
    TooLong,
    Empty,
    /// Folder-name only: a Windows reserved device name (CON, PRN, …).
    ReservedName,
    /// A case-insensitive sibling collision (used by folder ops, not by the
    /// single-name validators).
    CaseCollision,
    /// Folder-path only: nesting exceeds `MAX_FOLDER_DEPTH`.
    DepthExceeded,
}

impl FilenameIssueKind {
    /// Stable snake_case identifier — matches the TS `FilenameIssueKind`
    /// string union and the conformance fixtures.
    pub fn as_str(&self) -> &'static str {
        match self {
            FilenameIssueKind::ForbiddenChars => "forbidden_chars",
            FilenameIssueKind::LeadingDots => "leading_dots",
            FilenameIssueKind::TrailingDots => "trailing_dots",
            FilenameIssueKind::TooLong => "too_long",
            FilenameIssueKind::Empty => "empty",
            FilenameIssueKind::ReservedName => "reserved_name",
            FilenameIssueKind::CaseCollision => "case_collision",
            FilenameIssueKind::DepthExceeded => "depth_exceeded",
        }
    }
}

/// A single validation issue found in a title.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilenameIssue {
    pub kind: FilenameIssueKind,
    pub message: String,
}

// ── Forbidden character check ───────────────────────────────────────────

/// Returns true if `c` is forbidden in a note title/filename.
/// Matches the TypeScript `FORBIDDEN_CHARS_RE`: `< > : " / \ | ? *` plus
/// all control characters (0x00–0x1F and 0x7F).
fn is_forbidden_char(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()
}

/// Returns true if the string contains any forbidden characters.
fn contains_forbidden(s: &str) -> bool {
    s.chars().any(is_forbidden_char)
}

// ── Title sanitization (matches TS sanitizeTitle) ───────────────────────

/// Canonical title sanitization. Strips filesystem-breaking characters and
/// surrounding whitespace. Does not rewrite dots or silently truncate.
pub fn sanitize_title(title: &str) -> String {
    let result: String = title.chars().filter(|c| !is_forbidden_char(*c)).collect();
    let trimmed = result.trim();
    // If all-dots after stripping, treat as empty
    if trimmed.chars().all(|c| c == '.') && !trimmed.is_empty() {
        return FALLBACK_TITLE.to_string();
    }
    if trimmed.is_empty() {
        return FALLBACK_TITLE.to_string();
    }
    trimmed.to_string()
}

/// Validate a title and return a list of specific issues found.
/// Does NOT modify the title — use `sanitize_title()` for that.
pub fn validate_title(title: &str) -> Vec<FilenameIssue> {
    let mut issues = Vec::new();

    if title.trim().is_empty() {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::Empty,
            message: "Title cannot be empty".to_string(),
        });
        return issues;
    }

    if contains_forbidden(title) {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::ForbiddenChars,
            message: "That character can't be used in a note title".to_string(),
        });
    }

    if title.starts_with('.') {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::LeadingDots,
            message: "Title cannot start with a dot".to_string(),
        });
    }

    if title.ends_with('.') {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::TrailingDots,
            message: "Title cannot end with a dot".to_string(),
        });
    }

    // Count UTF-16 code units to match the TS reference's `title.length`
    // (JS strings are UTF-16). Using `.len()` (UTF-8 bytes) would diverge for
    // non-ASCII titles near the limit and break cross-language conformance.
    if title.encode_utf16().count() > MAX_TITLE_LENGTH {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::TooLong,
            message: format!("Title cannot exceed {MAX_TITLE_LENGTH} characters"),
        });
    }

    issues
}

/// Convenience: returns true if the title has no validation issues.
pub fn is_valid_title(title: &str) -> bool {
    validate_title(title).is_empty()
}

// ── Path safety ─────────────────────────────────────────────────────────

/// Maximum folder depth for note paths. Matches `MAX_FOLDER_DEPTH` in
/// `packages/shared/src/filename.ts`. A note at the root has depth 0;
/// `Specs/folder-support` has depth 1; the limit is applied to the
/// number of folder components above the leaf.
pub const MAX_FOLDER_DEPTH: usize = 10;

/// Forbidden character set for a single path component. Same as
/// `is_forbidden_char` but with `/` and `\` excluded — those are valid
/// path separators in a note ID, so we check them at the splitter
/// instead of the per-component check.
fn is_forbidden_in_component(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || c.is_control()
}

/// True if a single path component (one segment between `/`) is invalid.
fn component_invalid(component: &str) -> bool {
    if component.is_empty() || component == "." || component == ".." {
        return true;
    }
    component.chars().any(is_forbidden_in_component)
}

/// Validate a note ID. A note ID is the relative path from the notes
/// root WITHOUT the `.md` extension. Forward slashes are allowed as
/// path separators between valid components; backslashes are not.
///
/// Rejects: empty, leading/trailing slash, `.` / `..` components,
/// empty components (double slash), excessive depth, and any component
/// containing forbidden filesystem characters.
pub fn ensure_safe_note_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("note id cannot be empty".to_string());
    }
    if id.contains('\\') {
        return Err("invalid note id".to_string());
    }
    if id.starts_with('/') || id.ends_with('/') {
        return Err("invalid note id".to_string());
    }
    let components: Vec<&str> = id.split('/').collect();
    // Folder depth = number of components above the leaf. Reject anything
    // that would create a folder tree deeper than MAX_FOLDER_DEPTH.
    if components.len().saturating_sub(1) > MAX_FOLDER_DEPTH {
        return Err("note id exceeds maximum folder depth".to_string());
    }
    for component in &components {
        if component_invalid(component) {
            return Err("invalid note id".to_string());
        }
    }
    Ok(())
}

/// Build the full `.md` path for a note ID, after safety validation.
/// Note IDs may contain forward slashes — each segment becomes a folder.
//
// `PathBuf::set_extension` replaces whatever Rust considers the existing
// extension (everything after the final dot in the file_name), so for an id
// like "FUTO Notes 1.4.1 writeup" it would land at "FUTO Notes 1.4.md". Build
// the leaf with `.md` already appended instead.
pub fn safe_note_path(base: &Path, id: &str) -> Result<PathBuf, String> {
    ensure_safe_note_id(id)?;
    let mut path = base.to_path_buf();
    let mut components = id.split('/').peekable();
    while let Some(component) = components.next() {
        if components.peek().is_some() {
            path.push(component);
        } else {
            path.push(format!("{component}.md"));
        }
    }
    Ok(path)
}

/// Windows reserved device names. Matched case-insensitively. Enforced on
/// every platform so a vault created on macOS/Linux still syncs cleanly to a
/// Windows client. Matches `WINDOWS_RESERVED_NAMES` in `filename.ts`; the note
/// domain (`futo-notes-model::filename`) re-exports [`is_windows_reserved_name`]
/// so folder validation and the sync boundary share one definition.
const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// True if `name` (sans extension) is a Windows-reserved device name.
///
/// Mirrors TS `isWindowsReservedName`: take the stem up to the FIRST `.`
/// (`CON.md` → `CON`), uppercase, then membership-test.
pub fn is_windows_reserved_name(name: &str) -> bool {
    let stem = match name.find('.') {
        Some(idx) => &name[..idx],
        None => name,
    };
    let upper = stem.to_uppercase();
    WINDOWS_RESERVED_NAMES.iter().any(|r| *r == upper)
}

/// Strip the final `.ext` from a leaf filename, returning the stem. No dot →
/// the whole name.
fn strip_final_extension(name: &str) -> &str {
    match name.rfind('.') {
        Some(idx) => &name[..idx],
        None => name,
    }
}

/// True if a single INCOMING sync-path component (a folder segment, or the
/// leaf's stem with its extension already removed) is unsafe. Stricter than
/// [`ensure_safe_note_id`]'s per-component check: on top of the empty / `.` /
/// `..` / forbidden-character rules it also rejects Windows-reserved device
/// names and the leading dot / trailing dot-or-space that Windows silently
/// strips (so `note ` and `note.` would collide with `note`). These are the
/// same rules local note/folder creation enforces via `validate_title` +
/// `validate_folder_name`; applying them at the sync boundary stops a buggy or
/// older peer from landing a name local CRUD would refuse.
fn incoming_component_invalid(stem: &str) -> bool {
    if stem.is_empty() || stem == "." || stem == ".." {
        return true;
    }
    if stem.chars().any(is_forbidden_in_component) {
        return true;
    }
    if is_windows_reserved_name(stem) {
        return true;
    }
    // Windows drops trailing dots/spaces; a leading dot marks a hidden file.
    stem.starts_with('.') || stem.ends_with('.') || stem.ends_with(' ')
}

/// Validate a relative INCOMING sync path (as pushed by a peer, forward- or
/// back-slashed). Rejects traversal, excess depth, and — per
/// [`incoming_component_invalid`] — any folder component or leaf stem that
/// local CRUD would refuse. Does NOT check the extension: the note-vs-blob-vs-
/// ignore decision is [`crate::image::is_syncable_filename`]'s job, applied by
/// the caller before this so legacy-image blobs are silently ignored (not
/// reported as invalid). Returns `Err(reason)` naming the bad component.
pub fn ensure_safe_incoming_sync_path(rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Err("empty path".to_string());
    }
    let normalized = rel.replace('\\', "/");
    if normalized.starts_with('/') || normalized.ends_with('/') {
        return Err("leading or trailing slash".to_string());
    }
    let components: Vec<&str> = normalized.split('/').collect();
    if components.len().saturating_sub(1) > MAX_FOLDER_DEPTH {
        return Err("exceeds maximum folder depth".to_string());
    }
    let last = components.len() - 1;
    for (i, component) in components.iter().enumerate() {
        let stem = if i == last {
            strip_final_extension(component)
        } else {
            component
        };
        if incoming_component_invalid(stem) {
            return Err(format!("unsafe path component: {component:?}"));
        }
    }
    Ok(())
}

/// Build a path under `base` from a relative path, rejecting traversal.
pub fn safe_appdata_path(base: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel_path);
    for component in rel.components() {
        match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("path traversal blocked".to_string())
            }
            _ => {}
        }
    }
    Ok(base.join(rel))
}

// ── File I/O helpers ────────────────────────────────────────────────────

/// Current time in milliseconds since Unix epoch.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Use `modified_at` if provided (> 0), otherwise fall back to current time.
/// A value of 0 means "not provided" (the `#[serde(default)]` sentinel).
pub fn mtime_or_now(modified_at: i64) -> i64 {
    if modified_at > 0 {
        modified_at
    } else {
        now_ms()
    }
}

/// Extract mtime from file metadata as milliseconds since epoch.
pub fn file_mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(now_ms)
}

/// Set the mtime of a file to the given millisecond timestamp.
pub fn set_file_mtime_ms(path: &Path, modified_at_ms: i64) -> Result<(), String> {
    let filetime = FileTime::from_unix_time(
        modified_at_ms / 1000,
        ((modified_at_ms % 1000) * 1_000_000) as u32,
    );
    set_file_mtime(path, filetime).map_err(|e| e.to_string())
}

/// Atomically write text to a file (write to temp, then rename).
pub fn write_atomic_text(path: &Path, content: &str) -> Result<(), String> {
    write_atomic_bytes(path, content.as_bytes())
}

/// Atomically write raw `bytes` to `path` (binary-safe sibling of
/// [`write_atomic_text`]). Used for image blobs, whose contents are not valid
/// UTF-8. Every guarantee `write_atomic_text` makes — create_dir_all, a
/// unique temp name, the rename + case-collision recovery — applies here; the
/// text wrapper simply forwards `content.as_bytes()`.
pub fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid file path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;

    // Use a short temp name to avoid exceeding filesystem limits (ext4: 255 bytes).
    // The old pattern `.{filename}.tmp-{ts}` could overflow for long filenames.
    // Include a process-wide counter so two writes in the same millisecond (or
    // concurrent writers in the same dir) never share a temp path — a shared
    // temp name could be renamed away under us and surface as a spurious rename
    // failure mid-sync.
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".sf-tmp-{}-{}", now_ms(), seq));
    fs::write(&tmp, bytes).map_err(|e| format!("{e} (writing temp {})", tmp.display()))?;
    if let Err(e) = fs::rename(&tmp, path) {
        // On a case-insensitive filesystem (default APFS on macOS/iOS, NTFS on
        // Windows) `rename` onto a destination that differs only in case from an
        // existing entry can fail with `AlreadyExists` (EEXIST) instead of
        // overwriting — e.g. syncing a note `welcome.md` when the vault already
        // holds `Welcome.md`. POSIX rename would overwrite; this edge does not.
        // Recover the intended overwrite semantics: PARK the colliding entry
        // (exact path, then any case-variant in the same directory) under a
        // hidden backup name, retry the rename, then drop the backup. Parking
        // instead of deleting keeps the previous bytes on disk if we crash
        // between clearing the collision and installing the temp file — the
        // old delete-then-rename sequence lost them permanently in that
        // window. On case-sensitive filesystems this branch never triggers
        // (rename overwrites cleanly), so behavior there is unchanged.
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            let parked = park_case_variants(parent, path);
            if let Err(e2) = fs::rename(&tmp, path) {
                // Put the collision back — keeping the old note beats
                // losing both versions.
                for (original, backup) in parked {
                    let _ = fs::rename(&backup, &original);
                }
                let _ = fs::remove_file(&tmp);
                return Err(format!(
                    "{e2} (renaming {} -> {} after case-collision recovery)",
                    tmp.display(),
                    path.display()
                ));
            }
            for (_original, backup) in parked {
                let _ = fs::remove_file(&backup);
            }
            return Ok(());
        }
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "{e} (renaming {} -> {})",
            tmp.display(),
            path.display()
        ));
    }
    Ok(())
}

// ── Image-blob sync content (base64 over the text frame) ─────────────────
//
// The E2EE sync wire format (`pack_note_v2`) carries `content` as a UTF-8
// string, and every layer of the orchestrator's object map / hashing / change
// detection treats that content as opaque text. Image binaries are not valid
// UTF-8, so to sync them through the unchanged pipeline we base64-encode the
// bytes into that text `content` and decode on the way back to disk. The
// server only ever sees the encrypted blob, so the base64 expansion is
// invisible to it; the only cost is ~33% larger ciphertext, well under the
// server's blob-size limit for the small images notes embed.

/// Read an image blob from disk and return its standard-base64 encoding,
/// suitable for use as the `content` string of a sync note frame.
pub fn read_blob_as_base64(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(bytes))
}

/// Decode base64 `content` (produced by [`read_blob_as_base64`] on a peer)
/// back to raw bytes and atomically write them to `path`.
pub fn write_base64_as_blob(path: &Path, content: &str) -> Result<(), String> {
    let bytes = STANDARD
        .decode(content.as_bytes())
        .map_err(|e| format!("invalid base64 image content: {e}"))?;
    write_atomic_bytes(path, &bytes)
}

/// Remove `path` if it exists, plus any directory entry in `parent` whose name
/// matches `path`'s filename case-insensitively. Used to recover the overwrite
/// semantics of `rename` on case-insensitive filesystems, where a destination
/// differing only in case blocks the rename with EEXIST. Best-effort: errors
/// are ignored (the retry rename surfaces any real failure).
/// Park every file in `parent` whose name case-matches `path`'s filename
/// under a hidden `.sf-bak-…` name (a dotfile with no `.md` suffix, so the
/// scanner, watcher, and sync inventory all ignore it). Returns
/// `(original, backup)` pairs so a failed retry can restore them. A
/// directory that happens to case-match is never parked — only files are
/// valid note targets.
fn park_case_variants(parent: &Path, path: &Path) -> Vec<(PathBuf, PathBuf)> {
    let Some(target) = path.file_name().and_then(|n| n.to_str()) else {
        return Vec::new();
    };
    let mut parked = Vec::new();
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !name.eq_ignore_ascii_case(target) {
                continue;
            }
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let backup = parent.join(format!(".sf-bak-{}-{}", now_ms(), seq));
            if fs::rename(&p, &backup).is_ok() {
                parked.push((p, backup));
            }
        }
    }
    parked
}

/// Rename `src` to `dst` via a hidden temporary name (`src` → `.sf-tmp-…` →
/// `dst`). Used for a case-only / NFC-vs-NFD rename on a case-insensitive,
/// normalization-insensitive filesystem (default APFS on macOS/iOS, NTFS on
/// Windows), where `fs::rename(src, dst)` is a no-op or fails because the
/// kernel treats `dst` as already being `src` — so the stored case/normal
/// form never changes. The temp hop forces the kernel to drop the old
/// directory entry and create a fresh one with the requested bytes.
///
/// The temp name is a dotfile with no `.md` suffix, so the scanner, watcher,
/// and sync inventory all ignore it if we crash mid-rename. On a failed
/// second hop we roll the temp file back to `src` so the note is never lost.
pub fn rename_through_temp(src: &Path, dst: &Path) -> Result<(), String> {
    let parent = src
        .parent()
        .ok_or_else(|| "invalid source path".to_string())?;
    if let Some(dparent) = dst.parent() {
        fs::create_dir_all(dparent).map_err(|e| e.to_string())?;
    }
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".sf-tmp-{}-{}", now_ms(), seq));
    fs::rename(src, &tmp).map_err(|e| {
        format!("{e} (renaming {} -> temp {})", src.display(), tmp.display())
    })?;
    if let Err(e) = fs::rename(&tmp, dst) {
        // Roll back so the note survives — keeping the source beats losing it.
        let _ = fs::rename(&tmp, src);
        return Err(format!(
            "{e} (renaming temp {} -> {})",
            tmp.display(),
            dst.display()
        ));
    }
    Ok(())
}

/// Extract a note ID from a filename by stripping the `.md` extension.
/// Returns `None` for non-`.md` files or if the resulting ID is empty.
pub fn note_id_from_filename(name: &str) -> Option<String> {
    let id = name.strip_suffix(".md")?;
    if id.is_empty() {
        return None;
    }
    Some(id.to_string())
}

/// Convert a relative path under the notes root (e.g. `Specs/foo.md`)
/// into a note ID (e.g. `Specs/foo`). Returns `None` for non-`.md` paths
/// or if the resulting ID would be empty. Paths are normalized to use
/// forward slashes so the ID format matches across Windows / Unix.
pub fn note_id_from_relative_path(rel: &str) -> Option<String> {
    let normalized = rel.replace('\\', "/");
    let id = normalized.strip_suffix(".md")?;
    if id.is_empty() {
        return None;
    }
    if id.contains("//") {
        return None;
    }
    if id.starts_with('/') || id.ends_with('/') {
        return None;
    }
    Some(id.to_string())
}

/// Find a unique note ID by appending `-2`, `-3`, ... if needed.
/// If `wanted` matches `exclude`, it is returned directly (used for renames).
pub fn get_unique_note_id(
    base: &Path,
    wanted: &str,
    exclude: Option<&str>,
) -> Result<String, String> {
    if Some(wanted) == exclude {
        return Ok(wanted.to_string());
    }

    let wanted_path = safe_note_path(base, wanted)?;
    if !wanted_path.exists() {
        return Ok(wanted.to_string());
    }

    let mut counter = 2;
    loop {
        let candidate = format!("{wanted}-{counter}");
        if Some(candidate.as_str()) == exclude {
            return Ok(candidate);
        }
        let candidate_path = safe_note_path(base, &candidate)?;
        if !candidate_path.exists() {
            return Ok(candidate);
        }
        counter += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("futo-notes-core-files-test-{}-{n}", now_ms()));
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    // ── ensure_safe_note_id ─────────────────────────────────────────

    #[test]
    fn safe_id_rejects_empty() {
        assert!(ensure_safe_note_id("").is_err());
    }

    #[test]
    fn safe_id_rejects_traversal() {
        assert!(ensure_safe_note_id("..").is_err());
        assert!(ensure_safe_note_id(".").is_err());
        assert!(ensure_safe_note_id("foo/..").is_err());
        assert!(ensure_safe_note_id("../foo").is_err());
        assert!(ensure_safe_note_id("foo/./bar").is_err());
        assert!(ensure_safe_note_id("foo\\bar").is_err());
        assert!(ensure_safe_note_id("/foo").is_err());
        assert!(ensure_safe_note_id("foo/").is_err());
        assert!(ensure_safe_note_id("foo//bar").is_err());
    }

    #[test]
    fn safe_id_accepts_path_components() {
        assert!(ensure_safe_note_id("Specs/folder-support").is_ok());
        assert!(ensure_safe_note_id("a/b/c").is_ok());
    }

    #[test]
    fn safe_id_rejects_excessive_depth() {
        let too_deep = (0..MAX_FOLDER_DEPTH + 2)
            .map(|i| format!("d{i}"))
            .collect::<Vec<_>>()
            .join("/");
        assert!(ensure_safe_note_id(&too_deep).is_err());
    }

    #[test]
    fn safe_note_path_handles_nested_id() {
        let base = Path::new("/tmp/test");
        let p = safe_note_path(base, "Specs/folder-support").unwrap();
        assert_eq!(p, PathBuf::from("/tmp/test/Specs/folder-support.md"));
    }

    // Regression: titles with interior dots (e.g. version-like "1.4.1") were
    // being truncated by PathBuf::set_extension because Rust treated the
    // trailing dotted segment as the extension and replaced it. A note titled
    // "FUTO Notes 1.4.1 writeup" landed on disk as "FUTO Notes 1.4.md", which
    // made a single note show up as two entries (one in cache, one from
    // rescan) and never round-tripped correctly.
    #[test]
    fn safe_note_path_preserves_interior_dots() {
        let base = Path::new("/tmp/test");
        assert_eq!(
            safe_note_path(base, "FUTO Notes 1.4.1 writeup").unwrap(),
            PathBuf::from("/tmp/test/FUTO Notes 1.4.1 writeup.md"),
        );
        assert_eq!(
            safe_note_path(base, "v2.0 notes").unwrap(),
            PathBuf::from("/tmp/test/v2.0 notes.md"),
        );
        assert_eq!(
            safe_note_path(base, "Specs/v1.2 plan").unwrap(),
            PathBuf::from("/tmp/test/Specs/v1.2 plan.md"),
        );
    }

    #[test]
    fn write_atomic_text_basic_roundtrip() {
        let dir = temp_dir();
        let path = dir.join("note.md");
        write_atomic_text(&path, "hello").expect("write");
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
        // No temp litter left behind.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".sf-tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
        cleanup(&dir);
    }

    // Regression: on a case-insensitive filesystem (default APFS on macOS/iOS),
    // syncing a note whose filename differs only in case from an existing file
    // (`welcome.md` vs `Welcome.md`) made `fs::rename` fail with EEXIST instead
    // of overwriting, which aborted the whole sync apply. write_atomic_text must
    // recover by overwriting the case-variant. On case-sensitive filesystems the
    // two coexist and this just writes the requested name.
    #[test]
    fn write_atomic_text_overwrites_case_variant() {
        let dir = temp_dir();
        let existing = dir.join("Welcome.md");
        fs::write(&existing, "old iOS welcome").unwrap();

        let target = dir.join("welcome.md");
        write_atomic_text(&target, "new mac welcome").expect("write must not EEXIST");

        // Exactly one welcome entry survives, holding the new content. On a
        // case-insensitive FS the on-disk name may keep either case; on a
        // case-sensitive FS both names can exist — assert the new content
        // landed under the requested name regardless.
        let welcome_entries: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("welcome.md")
            })
            .collect();
        assert!(!welcome_entries.is_empty(), "welcome note missing");
        // The requested path must be readable with the new content.
        let got = fs::read_to_string(&target).expect("requested path readable");
        assert_eq!(got, "new mac welcome");
        // No temp or backup litter. The collision recovery parks the old
        // entry as `.sf-bak-…` while installing the new file (crash-safety:
        // the old bytes survive a crash mid-recovery) and must clean the
        // backup up on success.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                let n = e.file_name();
                let n = n.to_string_lossy().into_owned();
                n.starts_with(".sf-tmp-") || n.starts_with(".sf-bak-")
            })
            .collect();
        assert!(leftovers.is_empty(), "temp/backup files left: {leftovers:?}");
        cleanup(&dir);
    }

    // F3: rename_through_temp must rewrite the stored bytes of a case-only
    // rename even on a case-insensitive FS, where a plain fs::rename is a
    // no-op. After the hop, exactly one entry exists with the requested case
    // and the original content; no temp litter remains.
    #[test]
    fn rename_through_temp_case_only() {
        let dir = temp_dir();
        let src = dir.join("note.md");
        fs::write(&src, "body").unwrap();
        let dst = dir.join("Note.md");
        rename_through_temp(&src, &dst).expect("temp-hop rename");

        // Exactly one .md entry remains, readable via the new path.
        let md: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".md"))
            .collect();
        assert_eq!(md.len(), 1, "case-only rename must not duplicate");
        assert_eq!(fs::read_to_string(&dst).unwrap(), "body");
        // No temp litter.
        let leftover: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".sf-tmp-"))
            .collect();
        assert!(leftover.is_empty(), "temp files left: {leftover:?}");
        cleanup(&dir);
    }

    #[test]
    fn note_id_from_relative_path_works() {
        assert_eq!(note_id_from_relative_path("foo.md"), Some("foo".into()));
        assert_eq!(
            note_id_from_relative_path("Specs/foo.md"),
            Some("Specs/foo".into()),
        );
        assert_eq!(
            note_id_from_relative_path("Specs\\foo.md"),
            Some("Specs/foo".into()),
        );
        assert_eq!(note_id_from_relative_path(".md"), None);
        assert_eq!(note_id_from_relative_path("foo.txt"), None);
    }

    #[test]
    fn safe_id_rejects_forbidden_chars() {
        assert!(ensure_safe_note_id("note<1>").is_err());
        assert!(ensure_safe_note_id("note:colon").is_err());
        assert!(ensure_safe_note_id("note\"quote").is_err());
        assert!(ensure_safe_note_id("note|pipe").is_err());
        assert!(ensure_safe_note_id("note?question").is_err());
        assert!(ensure_safe_note_id("note*star").is_err());
        // Control character
        assert!(ensure_safe_note_id("note\x00null").is_err());
        assert!(ensure_safe_note_id("note\x1ftab").is_err());
        assert!(ensure_safe_note_id("note\x7fdel").is_err());
    }

    #[test]
    fn safe_id_accepts_valid() {
        assert!(ensure_safe_note_id("hello world").is_ok());
        assert!(ensure_safe_note_id("café").is_ok());
        assert!(ensure_safe_note_id("my-note").is_ok());
        assert!(ensure_safe_note_id(".hidden").is_ok());
    }

    // ── safe_appdata_path ───────────────────────────────────────────

    #[test]
    fn appdata_path_rejects_traversal() {
        let base = Path::new("/tmp/test");
        assert!(safe_appdata_path(base, "..").is_err());
        assert!(safe_appdata_path(base, "../etc/passwd").is_err());
        assert!(safe_appdata_path(base, "/etc/passwd").is_err());
    }

    #[test]
    fn appdata_path_accepts_valid() {
        let base = Path::new("/tmp/test");
        assert!(safe_appdata_path(base, ".preferences.json").is_ok());
        assert!(safe_appdata_path(base, "subdir/file.json").is_ok());
        let result = safe_appdata_path(base, ".preferences.json").unwrap();
        assert_eq!(result, PathBuf::from("/tmp/test/.preferences.json"));
    }

    // ── write_atomic_text ───────────────────────────────────────────

    #[test]
    fn atomic_write_creates_file() {
        let base = temp_dir();
        let path = base.join("test-note.md");
        write_atomic_text(&path, "hello world").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello world");
        // No leftover .tmp files
        let tmps: Vec<_> = fs::read_dir(&base)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(tmps.is_empty());
        cleanup(&base);
    }

    #[test]
    fn atomic_write_overwrites() {
        let base = temp_dir();
        let path = base.join("overwrite.md");
        write_atomic_text(&path, "first").unwrap();
        write_atomic_text(&path, "second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        cleanup(&base);
    }

    // ── image blob base64 roundtrip ─────────────────────────────────

    #[test]
    fn blob_base64_roundtrip_preserves_non_utf8_bytes() {
        let base = temp_dir();
        let src = base.join("image-src.png");
        // A minimal byte sequence that is NOT valid UTF-8 (a PNG magic header
        // plus a stray 0xFF) — exactly the kind of content read_to_string
        // would have rejected.
        let raw: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe];
        write_atomic_bytes(&src, &raw).unwrap();

        // Encode from disk, then decode to a second path: bytes must match.
        let encoded = read_blob_as_base64(&src).unwrap();
        assert!(encoded.is_ascii(), "base64 output must be ASCII (valid UTF-8)");
        let dst = base.join("image-dst.png");
        write_base64_as_blob(&dst, &encoded).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), raw);
        cleanup(&base);
    }

    #[test]
    fn write_base64_as_blob_rejects_invalid_base64() {
        let base = temp_dir();
        let path = base.join("bad.png");
        // '!' is outside the base64 alphabet.
        assert!(write_base64_as_blob(&path, "not!base64!").is_err());
        cleanup(&base);
    }

    // ── note_id_from_filename ───────────────────────────────────────

    #[test]
    fn note_id_valid() {
        assert_eq!(note_id_from_filename("hello.md"), Some("hello".to_string()));
        assert_eq!(
            note_id_from_filename("my note.md"),
            Some("my note".to_string())
        );
    }

    #[test]
    fn note_id_non_md() {
        assert_eq!(note_id_from_filename("hello.txt"), None);
    }

    #[test]
    fn note_id_empty() {
        assert_eq!(note_id_from_filename(".md"), None);
    }

    // ── note_id_from_filename regression: .md / bare-id / malformed ─

    #[test]
    fn note_id_bare_id_no_extension() {
        // Bare IDs without .md must return None
        assert_eq!(note_id_from_filename("shopping"), None);
        assert_eq!(note_id_from_filename("my note"), None);
        assert_eq!(note_id_from_filename("café"), None);
    }

    #[test]
    fn note_id_double_md_suffix() {
        // Only one trailing .md stripped — the remaining ".md" becomes part of the ID
        assert_eq!(
            note_id_from_filename("note.md.md"),
            Some("note.md".to_string())
        );
    }

    #[test]
    fn note_id_triple_md_suffix() {
        assert_eq!(
            note_id_from_filename("note.md.md.md"),
            Some("note.md.md".to_string())
        );
    }

    #[test]
    fn note_id_case_sensitive_extension() {
        // strip_suffix is case-sensitive — .MD and .Md are not stripped
        assert_eq!(note_id_from_filename("note.MD"), None);
        assert_eq!(note_id_from_filename("note.Md"), None);
        assert_eq!(note_id_from_filename("note.mD"), None);
    }

    #[test]
    fn note_id_unicode_and_emoji() {
        assert_eq!(
            note_id_from_filename("café ☕.md"),
            Some("café ☕".to_string())
        );
        assert_eq!(
            note_id_from_filename("📝 notes.md"),
            Some("📝 notes".to_string())
        );
    }

    #[test]
    fn note_id_dots_in_title() {
        // Interior dots are fine — only .md at the very end is stripped
        assert_eq!(
            note_id_from_filename("v2.0 release.md"),
            Some("v2.0 release".to_string())
        );
        assert_eq!(
            note_id_from_filename("Dr. Smith.md"),
            Some("Dr. Smith".to_string())
        );
    }

    #[test]
    fn note_id_md_as_part_of_title() {
        // "markdown.md" → "markdown", not "mark" (no greedy stripping)
        assert_eq!(
            note_id_from_filename("markdown.md"),
            Some("markdown".to_string())
        );
        // ".md" embedded but not at suffix position
        assert_eq!(note_id_from_filename("file.md.txt"), None);
    }

    // ── get_unique_note_id ──────────────────────────────────────────

    #[test]
    fn unique_id_no_collision() {
        let base = temp_dir();
        let id = get_unique_note_id(&base, "new-note", None).unwrap();
        assert_eq!(id, "new-note");
        cleanup(&base);
    }

    #[test]
    fn unique_id_collision_increments() {
        let base = temp_dir();
        write_atomic_text(&base.join("taken.md"), "x").unwrap();
        let id = get_unique_note_id(&base, "taken", None).unwrap();
        assert_eq!(id, "taken-2");
        cleanup(&base);
    }

    #[test]
    fn unique_id_exclude_self() {
        let base = temp_dir();
        write_atomic_text(&base.join("note.md"), "x").unwrap();
        // When exclude == wanted, return wanted directly (rename case)
        let id = get_unique_note_id(&base, "note", Some("note")).unwrap();
        assert_eq!(id, "note");
        cleanup(&base);
    }

    // ── sanitize_title ──────────────────────────────────────────────

    #[test]
    fn sanitize_strips_forbidden() {
        assert_eq!(sanitize_title("hello<world>"), "helloworld");
        assert_eq!(sanitize_title("a:b|c*d"), "abcd");
    }

    #[test]
    fn sanitize_trims_whitespace() {
        assert_eq!(sanitize_title("  hello  "), "hello");
    }

    #[test]
    fn sanitize_fallback_on_empty() {
        assert_eq!(sanitize_title(""), FALLBACK_TITLE);
        assert_eq!(sanitize_title("   "), FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_fallback_on_all_dots() {
        assert_eq!(sanitize_title("..."), FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_preserves_normal_text() {
        assert_eq!(sanitize_title("My grocery list"), "My grocery list");
        assert_eq!(sanitize_title("café notes"), "café notes");
    }

    // ── validate_title ──────────────────────────────────────────────

    #[test]
    fn validate_empty() {
        let issues = validate_title("");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, FilenameIssueKind::Empty);
    }

    #[test]
    fn validate_forbidden_chars() {
        let issues = validate_title("note<1>");
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::ForbiddenChars));
    }

    #[test]
    fn validate_leading_dots() {
        let issues = validate_title(".hidden");
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::LeadingDots));
    }

    #[test]
    fn validate_trailing_dots() {
        let issues = validate_title("file.");
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::TrailingDots));
    }

    #[test]
    fn validate_too_long() {
        let long_title = "a".repeat(MAX_TITLE_LENGTH + 1);
        let issues = validate_title(&long_title);
        assert!(issues.iter().any(|i| i.kind == FilenameIssueKind::TooLong));
    }

    #[test]
    fn validate_clean_title() {
        assert!(validate_title("My grocery list").is_empty());
        assert!(is_valid_title("My grocery list"));
    }

    // ── Cross-validation: sanitize output accepted by ensure_safe ───

    #[test]
    fn sanitized_output_passes_safe_id() {
        let inputs = [
            "hello<world>",
            "a:b|c*d",
            "note\x00null",
            "café ☕",
            "   spaces   ",
            "...",
        ];
        for input in &inputs {
            let sanitized = sanitize_title(input);
            // sanitize_title should never produce something that ensure_safe_note_id rejects
            // (except for leading dots which is a validation concern, not a safety concern)
            if !sanitized.starts_with('.') {
                assert!(
                    ensure_safe_note_id(&sanitized).is_ok(),
                    "sanitize_title({input:?}) produced {sanitized:?} which is rejected by ensure_safe_note_id"
                );
            }
        }
    }

    // ── file_mtime_ms / set_file_mtime_ms ───────────────────────────

    #[test]
    fn mtime_round_trip() {
        let base = temp_dir();
        let path = base.join("mtime-test.md");
        write_atomic_text(&path, "content").unwrap();

        let target_ms: i64 = 1_700_000_000_000;
        set_file_mtime_ms(&path, target_ms).unwrap();

        let meta = fs::metadata(&path).unwrap();
        let read_ms = file_mtime_ms(&meta);
        // Allow 1-second tolerance for filesystem granularity
        assert!(
            (read_ms - target_ms).abs() < 1000,
            "mtime mismatch: {read_ms} vs {target_ms}"
        );

        cleanup(&base);
    }

    // ── Adversarial: Unicode filenames ──────────────────────────────────

    #[test]
    fn sanitize_emoji_title() {
        let result = sanitize_title("📝 My Notes 🎵");
        assert_eq!(result, "📝 My Notes 🎵");
        assert!(ensure_safe_note_id(&result).is_ok());
    }

    #[test]
    fn sanitize_cjk_characters() {
        let result = sanitize_title("日本語ノート");
        assert_eq!(result, "日本語ノート");
        assert!(ensure_safe_note_id(&result).is_ok());
    }

    #[test]
    fn sanitize_rtl_text() {
        let result = sanitize_title("مرحبا بالعالم");
        assert_eq!(result, "مرحبا بالعالم");
        assert!(ensure_safe_note_id(&result).is_ok());
    }

    #[test]
    fn sanitize_zero_width_joiners() {
        // Family emoji: person + ZWJ + person + ZWJ + child
        let title = "Family 👨\u{200D}👩\u{200D}👧 notes";
        let result = sanitize_title(title);
        assert!(!result.is_empty());
        assert_ne!(result, FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_mixed_scripts() {
        let result = sanitize_title("Hello مرحبا 你好 🌍");
        assert_eq!(result, "Hello مرحبا 你好 🌍");
    }

    // ── Adversarial: Title length boundaries ────────────────────────────

    #[test]
    fn validate_title_exactly_max_length() {
        let title = "a".repeat(MAX_TITLE_LENGTH);
        assert!(
            validate_title(&title).is_empty(),
            "exactly MAX_TITLE_LENGTH should be valid"
        );
    }

    #[test]
    fn validate_title_one_over_max() {
        let title = "a".repeat(MAX_TITLE_LENGTH + 1);
        let issues = validate_title(&title);
        assert!(issues.iter().any(|i| i.kind == FilenameIssueKind::TooLong));
    }

    #[test]
    fn validate_title_one_under_max() {
        let title = "a".repeat(MAX_TITLE_LENGTH - 1);
        assert!(validate_title(&title).is_empty());
    }

    #[test]
    fn sanitize_very_long_title_250_chars() {
        // sanitize_title does NOT truncate — it only strips forbidden chars
        let title = "a".repeat(250);
        let result = sanitize_title(&title);
        assert_eq!(result.len(), 250, "sanitize should not truncate");
    }

    // ── Adversarial: Titles that are only special chars ─────────────────

    #[test]
    fn sanitize_only_whitespace() {
        assert_eq!(sanitize_title("   "), FALLBACK_TITLE);
        assert_eq!(sanitize_title("\t\t"), FALLBACK_TITLE);
        assert_eq!(sanitize_title("\n\n"), FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_only_dots() {
        assert_eq!(sanitize_title("."), FALLBACK_TITLE);
        assert_eq!(sanitize_title(".."), FALLBACK_TITLE);
        assert_eq!(sanitize_title("..."), FALLBACK_TITLE);
        assert_eq!(sanitize_title("......................"), FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_only_forbidden_chars() {
        assert_eq!(sanitize_title("<>:\"/\\|?*"), FALLBACK_TITLE);
        assert_eq!(sanitize_title("***"), FALLBACK_TITLE);
        assert_eq!(sanitize_title("???"), FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_mixed_valid_invalid() {
        assert_eq!(sanitize_title("he<ll>o"), "hello");
        assert_eq!(sanitize_title("a*b*c"), "abc");
        assert_eq!(sanitize_title("note: important"), "note important");
    }

    #[test]
    fn sanitize_control_characters_only() {
        // All control chars (0x00-0x1F, 0x7F) should be stripped
        let title = "\x00\x01\x02\x1f\x7f";
        assert_eq!(sanitize_title(title), FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_mixed_control_and_text() {
        assert_eq!(sanitize_title("hel\x00lo"), "hello");
        assert_eq!(sanitize_title("\x01good\x02"), "good");
    }

    // ── Adversarial: sanitize→ensure_safe consistency ───────────────────

    #[test]
    fn sanitize_output_always_passes_ensure_safe_wide_range() {
        let long_title = "a".repeat(300);
        let adversarial_inputs = [
            "",
            "   ",
            "...",
            ".",
            "..",
            "<>:\"/\\|?*",
            "\x00\x01\x02",
            "hello<world>",
            "a:b|c*d",
            "note\x00null",
            "café ☕",
            "📝🎵🎶",
            "日本語",
            "مرحبا",
            "hello\x7fworld",
            "   ...   ",
            "***only stars***",
            "normal title",
            long_title.as_str(),
            ".hidden",
            "trailing.",
            "..leading",
        ];
        for input in &adversarial_inputs {
            let sanitized = sanitize_title(input);
            assert!(!sanitized.is_empty(), "sanitize({input:?}) returned empty");
            // sanitize should always produce something ensure_safe accepts
            // (dots are a validation concern, but ensure_safe should still accept them)
            let result = ensure_safe_note_id(&sanitized);
            assert!(
                result.is_ok(),
                "sanitize_title({input:?}) = {sanitized:?} rejected by ensure_safe_note_id: {:?}",
                result.err()
            );
        }
    }

    // ── Adversarial: Path traversal attacks ─────────────────────────────

    #[test]
    fn safe_id_rejects_path_traversal_variants() {
        // Forward-slash separated path components are LEGAL post-folder-support
        // (a note ID like `Specs/foo` is valid). We still reject backslash,
        // dot/dotdot components, and absolute or empty boundary cases.
        let attacks = [
            "..",
            ".",
            "foo\\bar",
            "../etc/passwd",
            "..\\windows\\system32",
            "foo/../bar",
            "foo/./bar",
            "/foo",
            "foo/",
            "foo//bar",
        ];
        for attack in &attacks {
            assert!(
                ensure_safe_note_id(attack).is_err(),
                "ensure_safe_note_id should reject {attack:?}"
            );
        }
    }

    #[test]
    fn safe_id_rejects_null_bytes() {
        assert!(ensure_safe_note_id("note\x00").is_err());
        assert!(ensure_safe_note_id("\x00note").is_err());
        assert!(ensure_safe_note_id("no\x00te").is_err());
    }

    #[test]
    fn safe_appdata_rejects_traversal_variants() {
        let base = Path::new("/tmp/notes");
        let attacks = [
            "..",
            "../etc/passwd",
            "../../etc/shadow",
            "/etc/passwd",
            "foo/../../../etc/passwd",
        ];
        for attack in &attacks {
            assert!(
                safe_appdata_path(base, attack).is_err(),
                "safe_appdata_path should reject {attack:?}"
            );
        }
    }

    #[test]
    fn safe_appdata_rejects_windows_absolute() {
        let base = Path::new("/tmp/notes");
        // On Unix these parse differently, but the / and \ checks should still catch them
        assert!(safe_appdata_path(base, "/absolute/path").is_err());
    }

    #[test]
    fn safe_id_accepts_dots_in_middle() {
        // "v2.0" is a valid note ID — dots are only special as the entire name
        assert!(ensure_safe_note_id("v2.0").is_ok());
        assert!(ensure_safe_note_id("my.note.title").is_ok());
    }

    #[test]
    fn safe_id_accepts_hidden_files() {
        // .hidden is accepted by ensure_safe (validation is separate)
        assert!(ensure_safe_note_id(".hidden").is_ok());
    }

    #[test]
    fn safe_id_rejects_trailing_spaces_with_forbidden() {
        // Trailing spaces themselves aren't forbidden, but control chars are
        assert!(ensure_safe_note_id("note\x00").is_err());
    }

    // ── Adversarial: get_unique_note_id with many collisions ────────────

    #[test]
    fn unique_id_100_collisions() {
        let base = temp_dir();
        // Create 100 files: taken.md, taken-2.md, ..., taken-100.md
        write_atomic_text(&base.join("taken.md"), "x").unwrap();
        for i in 2..=100 {
            write_atomic_text(&base.join(format!("taken-{i}.md")), "x").unwrap();
        }
        let id = get_unique_note_id(&base, "taken", None).unwrap();
        assert_eq!(id, "taken-101");
        cleanup(&base);
    }

    #[test]
    fn unique_id_exclude_matches_candidate() {
        let base = temp_dir();
        write_atomic_text(&base.join("note.md"), "x").unwrap();
        write_atomic_text(&base.join("note-2.md"), "x").unwrap();
        // Exclude "note-2" — should return "note-2" directly since it matches exclude
        let id = get_unique_note_id(&base, "note", Some("note-2")).unwrap();
        assert_eq!(id, "note-2");
        cleanup(&base);
    }

    // ── Adversarial: write_atomic_text edge cases ───────────────────────

    #[test]
    fn atomic_write_nested_nonexistent_dirs() {
        let base = temp_dir();
        let path = base.join("a").join("b").join("c").join("deep-note.md");
        write_atomic_text(&path, "deep content").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "deep content");
        cleanup(&base);
    }

    #[test]
    fn atomic_write_null_bytes_in_content() {
        let base = temp_dir();
        let path = base.join("null-bytes.md");
        let content = "hello\x00world\x00end";
        write_atomic_text(&path, content).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        cleanup(&base);
    }

    #[test]
    fn atomic_write_very_long_lines() {
        let base = temp_dir();
        let path = base.join("long-line.md");
        let content = "x".repeat(100_000);
        write_atomic_text(&path, &content).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        cleanup(&base);
    }

    #[test]
    fn atomic_write_mixed_line_endings() {
        let base = temp_dir();
        let path = base.join("mixed-endings.md");
        let content = "line1\nline2\r\nline3\rline4";
        write_atomic_text(&path, content).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        cleanup(&base);
    }

    #[test]
    fn atomic_write_empty_content() {
        let base = temp_dir();
        let path = base.join("empty.md");
        write_atomic_text(&path, "").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        cleanup(&base);
    }

    #[test]
    fn atomic_write_unicode_content() {
        let base = temp_dir();
        let path = base.join("unicode.md");
        let content = "café ☕ 日本語 مرحبا 📝 \u{FEFF}BOM";
        write_atomic_text(&path, content).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        cleanup(&base);
    }

    // ── Adversarial: note_id_from_filename edge cases ───────────────────

    #[test]
    fn note_id_from_double_md_extension() {
        // "note.md.md" — strip_suffix removes only the single trailing ".md"
        assert_eq!(
            note_id_from_filename("note.md.md"),
            Some("note.md".to_string())
        );
    }

    #[test]
    fn note_id_from_just_md() {
        // ".md" — id would be empty
        assert_eq!(note_id_from_filename(".md"), None);
    }

    #[test]
    fn note_id_from_md_in_middle() {
        // "my.md.notes.txt" — not .md extension
        assert_eq!(note_id_from_filename("my.md.notes.txt"), None);
    }

    #[test]
    fn note_id_unicode_filename() {
        assert_eq!(
            note_id_from_filename("日本語.md"),
            Some("日本語".to_string())
        );
        assert_eq!(
            note_id_from_filename("📝notes.md"),
            Some("📝notes".to_string())
        );
    }

    #[test]
    fn note_id_case_sensitivity() {
        // ".MD" is not ".md"
        assert_eq!(note_id_from_filename("note.MD"), None);
        assert_eq!(note_id_from_filename("note.Md"), None);
    }

    // ── Adversarial: validate_title edge cases ──────────────────────────

    #[test]
    fn validate_whitespace_only() {
        let issues = validate_title("   ");
        assert!(issues.iter().any(|i| i.kind == FilenameIssueKind::Empty));
    }

    #[test]
    fn validate_tab_only() {
        let issues = validate_title("\t\t");
        assert!(issues.iter().any(|i| i.kind == FilenameIssueKind::Empty));
    }

    #[test]
    fn validate_multiple_issues() {
        // ".note<1>" — leading dot + forbidden chars
        let issues = validate_title(".note<1>");
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::LeadingDots));
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::ForbiddenChars));
    }

    #[test]
    fn validate_leading_and_trailing_dots() {
        let issues = validate_title(".both.");
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::LeadingDots));
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::TrailingDots));
    }

    #[test]
    fn validate_long_with_forbidden() {
        let title = format!("{}<", "a".repeat(MAX_TITLE_LENGTH));
        let issues = validate_title(&title);
        assert!(issues.iter().any(|i| i.kind == FilenameIssueKind::TooLong));
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::ForbiddenChars));
    }

    #[test]
    fn validate_title_with_newlines() {
        // Newlines are control characters — should flag as forbidden
        let issues = validate_title("line1\nline2");
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::ForbiddenChars));
    }

    // ── is_windows_reserved_name ────────────────────────────────────
    #[test]
    fn windows_reserved_names() {
        assert!(is_windows_reserved_name("CON"));
        assert!(is_windows_reserved_name("con"));
        assert!(is_windows_reserved_name("CON.md"));
        assert!(is_windows_reserved_name("Nul.txt"));
        assert!(is_windows_reserved_name("COM1"));
        assert!(is_windows_reserved_name("LPT9.png"));
        assert!(!is_windows_reserved_name("CONSOLE"));
        assert!(!is_windows_reserved_name("note"));
        assert!(!is_windows_reserved_name("COM0"));
    }

    // ── ensure_safe_incoming_sync_path ──────────────────────────────
    #[test]
    fn incoming_sync_path_accepts_valid_names() {
        for ok in [
            "note.md",
            "Specs/folder-support.md",
            "a/b/c/deep.md",
            "image-1742345678901-xk7.png",
            "folder/photo.JPG",
            "weird.but.fine.name.md",
        ] {
            assert!(
                ensure_safe_incoming_sync_path(ok).is_ok(),
                "expected ok: {ok}"
            );
        }
    }

    #[test]
    fn incoming_sync_path_rejects_traversal_and_slashes() {
        for bad in ["../secret.md", "foo/../bar.md", "/abs.md", "trailing/", ""] {
            assert!(
                ensure_safe_incoming_sync_path(bad).is_err(),
                "expected err: {bad:?}"
            );
        }
        // Backslash traversal is normalized to forward slashes first.
        assert!(ensure_safe_incoming_sync_path("foo\\..\\bar.md").is_err());
    }

    #[test]
    fn incoming_sync_path_rejects_windows_reserved() {
        assert!(ensure_safe_incoming_sync_path("CON.md").is_err());
        assert!(ensure_safe_incoming_sync_path("nul.png").is_err());
        assert!(ensure_safe_incoming_sync_path("folder/COM1.md").is_err());
    }

    #[test]
    fn incoming_sync_path_rejects_forbidden_chars() {
        assert!(ensure_safe_incoming_sync_path("a<b.md").is_err());
        assert!(ensure_safe_incoming_sync_path("a:b.md").is_err());
        assert!(ensure_safe_incoming_sync_path("a\"b.md").is_err());
        assert!(ensure_safe_incoming_sync_path("a|b.md").is_err());
        assert!(ensure_safe_incoming_sync_path("a*b.md").is_err());
        assert!(ensure_safe_incoming_sync_path("ctrl\u{0007}bell.md").is_err());
        // Forbidden char in a folder component, not just the leaf.
        assert!(ensure_safe_incoming_sync_path("a<b/note.md").is_err());
    }

    #[test]
    fn incoming_sync_path_rejects_trailing_dot_or_space() {
        // `note..md` → leaf stem `note.` ends with a dot.
        assert!(ensure_safe_incoming_sync_path("note..md").is_err());
        // trailing space in the leaf stem
        assert!(ensure_safe_incoming_sync_path("note .md").is_err());
        // trailing dot/space in a folder component
        assert!(ensure_safe_incoming_sync_path("folder./note.md").is_err());
        assert!(ensure_safe_incoming_sync_path("folder /note.md").is_err());
        // leading dot (hidden) in a component
        assert!(ensure_safe_incoming_sync_path(".hidden.md").is_err());
    }

    #[test]
    fn incoming_sync_path_rejects_excess_depth() {
        // MAX_FOLDER_DEPTH folder components above the leaf is the limit.
        let ok = format!("{}leaf.md", "d/".repeat(MAX_FOLDER_DEPTH));
        assert!(ensure_safe_incoming_sync_path(&ok).is_ok());
        let too_deep = format!("{}leaf.md", "d/".repeat(MAX_FOLDER_DEPTH + 1));
        assert!(ensure_safe_incoming_sync_path(&too_deep).is_err());
    }
}
