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
    /// Multi-line, display-oriented preview for native note lists. See
    /// [`make_rich_preview`]. Empty when the note has no renderable body.
    pub rich_preview: String,
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

/// Max logical lines kept in a rich preview, and the overall code-point cap.
const RICH_PREVIEW_MAX_LINES: usize = 3;
const RICH_PREVIEW_MAX_CHARS: usize = 280;

/// A multi-line, display-oriented preview for the native note list.
///
/// Unlike [`make_preview`] (single-line, markdown-opaque, conformance-locked
/// against the TS twin) this rule is **presentation-only and native-only**: it
/// preserves line breaks and rewrites *block* markdown into something a
/// plain/inline-markdown renderer can show cleanly, so a list row no longer
/// shows raw `#`, `|`, or `- [ ]` syntax. Specifically, per non-blank line
/// (capped at [`RICH_PREVIEW_MAX_LINES`]):
///
///   - table rows and delimiter/rule lines are dropped entirely;
///   - code-fence lines (```` ``` ````, `~~~`) are dropped;
///   - ATX heading markers (`#`) and blockquote markers (`>`) are stripped;
///   - task items (`- [ ]` / `- [x]`) become `☐` / `☑`;
///   - plain bullets (`-`, `*`, `+`) become `•`.
///
/// **Inline** emphasis (`**bold**`, `*italic*`, `` `code` ``, links) is left
/// INTACT so the platform layer (SwiftUI `AttributedString` / Compose
/// `AnnotatedString`) can render it as actual styling rather than literal
/// markers. There is intentionally no TS twin — desktop keeps using the
/// single-line [`make_preview`].
pub fn make_rich_preview(content: &str) -> String {
    let mut lines: Vec<String> = Vec::new();

    for raw in content.lines() {
        if lines.len() >= RICH_PREVIEW_MAX_LINES {
            break;
        }
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue; // collapse blank lines
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            continue; // drop code-fence lines
        }
        if is_table_line(trimmed) {
            continue; // drop tables / delimiter / rule lines
        }
        let cleaned = clean_preview_line(trimmed);
        if cleaned.is_empty() {
            continue;
        }
        lines.push(cleaned);
    }

    let out = lines.join("\n");
    if out.chars().count() > RICH_PREVIEW_MAX_CHARS {
        return out.chars().take(RICH_PREVIEW_MAX_CHARS).collect();
    }
    out
}

/// A table row (`| a | b |`), or a line made only of table/rule punctuation
/// (`|---|---|`, `:--:`, `---`) — i.e. nothing worth showing in a preview.
fn is_table_line(line: &str) -> bool {
    if line.starts_with('|') {
        return true;
    }
    line.contains('-') && line.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
}

/// Strip leading block markers (heading / blockquote) and rewrite a leading
/// list/task marker into a display glyph. Inline markdown is left untouched.
fn clean_preview_line(line: &str) -> String {
    // Peel any nested blockquote markers: "> > text" → "text".
    let mut s = line;
    loop {
        let t = s.trim_start();
        match t.strip_prefix('>') {
            Some(rest) => s = rest,
            None => {
                s = t;
                break;
            }
        }
    }

    // ATX heading: 1–6 leading '#'s followed by a space (or end of line).
    let hashes = s.chars().take_while(|&c| c == '#').count();
    if (1..=6).contains(&hashes) {
        let after = &s[hashes..];
        if after.is_empty() || after.starts_with(' ') {
            s = after.trim_start();
        }
    }

    // Task item: "<bullet> [ ] …" / "<bullet> [x] …" → ☐ / ☑.
    let bytes = s.as_bytes();
    if bytes.len() >= 5
        && matches!(bytes[0], b'-' | b'*' | b'+')
        && bytes[1] == b' '
        && bytes[2] == b'['
        && bytes[4] == b']'
    {
        let glyph = match bytes[3] {
            b'x' | b'X' => Some("☑"),
            b' ' => Some("☐"),
            _ => None,
        };
        if let Some(glyph) = glyph {
            return format!("{glyph} {}", s[5..].trim_start());
        }
    }

    // Plain bullet: "- item" / "* item" / "+ item" → "• item".
    if bytes.len() >= 2 && matches!(bytes[0], b'-' | b'*' | b'+') && bytes[1] == b' ' {
        return format!("• {}", s[2..].trim_start());
    }

    s.trim().to_string()
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
                rich_preview: make_rich_preview(&content),
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

/// Outcome of [`write_note_if_unchanged`] — a conditional write.
#[derive(Debug, PartialEq, Eq)]
pub enum FlushOutcome {
    /// The note still held `expected_prev`; `content` was written.
    Wrote,
    /// The note no longer exists — nothing written (anti-resurrection guard).
    SkippedMissing,
    /// The note's on-disk content differs from `expected_prev` — nothing
    /// written, so a change made since the caller's snapshot is preserved.
    SkippedChanged,
}

/// Conditional write for a backgrounded editor flush: read the note at `id` and
/// write `content` **only if** its current on-disk content still equals
/// `expected_prev`. This collapses the editor's old "check `note_exists`, then
/// `write_note`" two-call sequence into one operation whose decision is made from
/// a single read:
///   * the note was deleted while the editor was backgrounded → `SkippedMissing`
///     (never resurrect it — the two-call sequence's cross-FFI TOCTOU could
///     recreate it);
///   * a live-sync pull adopted remote content since the editor's last read →
///     `SkippedChanged` (never clobber the adopted remote with a stale flush).
/// A genuinely-clean note (`current == expected_prev`) is overwritten atomically.
///
/// NOT a true compare-and-swap. This is check-then-atomic-write: the guard read
/// and the `write_atomic_text` rename are separate syscalls, so a delete or write
/// landing in the sub-syscall window between them is not prevented — the write
/// can still recreate a note deleted in that instant, or land on top of a change
/// applied in it. The residual window is accepted (PKT-12): it is single-process
/// and syscall-tight, strictly narrower than the two-FFI-hop gap it replaces, and
/// the only thing that would close it fully is per-vault mutation serialization
/// (the op-queue shape deliberately rejected as too invasive for the sync
/// orchestrator). If device QA ever shows real loss through this window, a
/// crash-safe journal is the escalation, not a lock.
///
/// `expected_prev` is the content the flushing editor believes is on disk (its
/// `savedContent`). Note bodies are small, so comparing the full string (rather
/// than a hash) keeps the semantics exact with no ambiguity.
pub fn write_note_if_unchanged(
    base: &Path,
    id: &str,
    expected_prev: &str,
    content: &str,
) -> Result<FlushOutcome, String> {
    let path = safe_note_path(base, id)?;
    match std::fs::read_to_string(&path) {
        Ok(current) if current == expected_prev => {
            write_atomic_text(&path, content)?;
            Ok(FlushOutcome::Wrote)
        }
        Ok(_) => Ok(FlushOutcome::SkippedChanged),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FlushOutcome::SkippedMissing),
        Err(e) => Err(e.to_string()),
    }
}

/// Create a new note from a title (+ optional folder). Returns the final,
/// collision-resolved id. Mirrors `NotesStore.createNote`.
pub fn create_note(base: &Path, folder: &str, title: &str) -> Result<String, String> {
    create_note_with_content(base, folder, title, "")
}

/// Create a new note from a title (+ optional folder) with its initial
/// `content` written in the SAME step. Returns the final, collision-resolved
/// id. Atomic-create: unlike `create_note` + a follow-up `write_note`, there is
/// no zero-byte window — a write failure leaves no orphan file behind (the note
/// domain owns the create-then-write workflow; AGENTS §4).
pub fn create_note_with_content(
    base: &Path,
    folder: &str,
    title: &str,
    content: &str,
) -> Result<String, String> {
    let wanted = make_id(folder, title);
    let id = get_unique_note_id(base, &wanted, None)?;
    write_note(base, &id, content)?;
    Ok(id)
}

// ── First-run seeding ────────────────────────────────────────────────────

/// Id (and therefore title) of the note seeded into an empty vault.
pub const WELCOME_NOTE_ID: &str = "Welcome";

/// The single user-facing note written on first launch. Plain Markdown that
/// introduces the app and demonstrates the features it mentions — no internal
/// implementation language. Owned here so iOS, Android, and any future shell
/// seed identical content and can't drift.
pub const WELCOME_NOTE: &str = "\
# Welcome to FUTO Notes

FUTO Notes keeps everything as plain Markdown files on your device. There's no \
account to create and nothing to sign in to — your notes are just files you own.

## Getting started
- Open a note to edit it; changes save as you type.

## Markdown you can use
- **Bold**, *italic*, and `inline code`
- Bulleted and numbered lists
- [ ] Checklists — tap a box to toggle it
- Group notes with #tags, or sort them into folders

Feel free to delete this note once you've had a look around.
";

/// Write the welcome note iff the vault has no notes yet. Returns the number
/// of notes seeded (0 when the vault already had content). Idempotent: safe to
/// call on every launch. Shells call this instead of embedding their own seed
/// content so the first-run experience stays identical across platforms.
pub fn seed_if_empty(base: &Path) -> Result<u32, String> {
    if !scan_notes(base).is_empty() {
        return Ok(0);
    }
    write_note(base, WELCOME_NOTE_ID, WELCOME_NOTE)?;
    Ok(1)
}

/// Delete a note. Missing file is not an error. Now-empty ancestor folders
/// are pruned up to (but never including) the vault root — the spec
/// (list.md) requires the prune on EVERY platform, so it lives here in the
/// shared path rather than in any one shell.
pub fn delete_note(base: &Path, id: &str) -> Result<(), String> {
    let path = safe_note_path(base, id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    prune_empty_parent_dirs(base, &path);
    Ok(())
}

/// Walk up from `path` removing empty directories until we hit `base` or a
/// non-empty directory. Never removes `base` itself and refuses to walk
/// outside it. ANY remaining entry — notes, images, subfolders, dotfiles
/// like `.futo` sync state — stops the walk. Best-effort: I/O errors end
/// the walk silently. The single prune implementation shared by the model's
/// `delete_note` and the Tauri shell's trash-routed delete / raw note move.
pub fn prune_empty_parent_dirs(base: &Path, path: &Path) {
    let mut cursor = match path.parent() {
        Some(p) => p.to_path_buf(),
        None => return,
    };
    loop {
        if cursor == base {
            return;
        }
        if !cursor.starts_with(base) {
            return;
        }
        match std::fs::read_dir(&cursor) {
            Ok(mut iter) => {
                if iter.next().is_some() {
                    return;
                }
            }
            Err(_) => return,
        }
        if std::fs::remove_dir(&cursor).is_err() {
            return;
        }
        let parent = match cursor.parent() {
            Some(p) => p.to_path_buf(),
            None => return,
        };
        cursor = parent;
    }
}

/// Whether two paths resolve to the SAME on-disk file. Used to tell a
/// case/NFC-insensitive filesystem folding two ids onto one entry (safe to
/// byte-rename in place) from two genuinely distinct files that merely share a
/// collision key (must not be overwritten). `canonicalize` returns the real
/// stored path, so case-variant names of one file compare equal while distinct
/// files compare unequal — on both case-sensitive and case-insensitive
/// filesystems. Both paths must exist for a positive result.
fn same_physical_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
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
    //
    // BUT this is only true when `old_id` and `new_id` are the SAME physical
    // entry (the case-insensitive filesystem folding them onto one file) or the
    // destination doesn't exist yet. On a case-SENSITIVE filesystem (Linux
    // ext4, Android) `note.md` and `Note.md` are DISTINCT files; taking the
    // temp hop there would rename `note` over the distinct `Note`, destroying
    // its bytes. When the destination is a distinct existing file, fall through
    // to the normal suffixing path (`Note` → `Note-2`) instead — clobbering it
    // would be silent data loss.
    if collides_but_differs(old_id, new_id) {
        let src = safe_note_path(base, old_id)?;
        let dst = safe_note_path(base, new_id)?;
        let dst_is_distinct_file = dst.exists() && !same_physical_file(&src, &dst);
        if !dst_is_distinct_file {
            rename_through_temp(&src, &dst)?;
            return Ok(new_id.to_string());
        }
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

/// Delete a folder non-destructively, mirroring the Tauri sidebar's
/// `confirmDeleteFolder` (DrawerSidebar.svelte) move-up semantics: every note
/// under `folder/` moves to the folder's parent with the deleted segment
/// removed and any deeper structure preserved (`A/B/C/x` → `A/C/x` when
/// deleting `A/B`), destination collisions resolve with the standard `-2`
/// suffix via `rename_note`, and wikilinks pointing at each moved note are
/// rewritten. Only then is the now-note-empty folder tree removed.
///
/// If ANY move fails, the folder is NOT deleted and an error is returned —
/// already-moved notes stay moved, exactly like the desktop flow (deleting
/// while orphans remain inside would be silent data loss). A missing folder
/// is a no-op `Ok(0)`. Returns the number of notes moved.
pub fn delete_folder_move_up(base: &Path, folder: &str) -> Result<u32, String> {
    // Refuse the vault root and anything that could escape it. The id-level
    // safety inside `rename_note` would block traversal on the moves too, but
    // the final `remove_dir_all` operates on the raw folder path, so it gets
    // its own gate.
    if folder.is_empty() || folder == "/" {
        return Err("cannot delete the vault root".to_string());
    }
    if folder.contains('\\') || folder.starts_with('/') || folder.ends_with('/') {
        return Err("invalid folder path".to_string());
    }
    for component in folder.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err("invalid folder path".to_string());
        }
    }
    let mut abs = base.to_path_buf();
    for component in folder.split('/') {
        abs.push(component);
    }
    if !abs.exists() {
        return Ok(0);
    }

    let parent = match folder.rfind('/') {
        Some(idx) => &folder[..idx],
        None => "",
    };
    let prefix = format!("{folder}/");
    let note_ids: Vec<String> = scan_notes(base)
        .into_iter()
        .filter(|n| n.id.starts_with(&prefix))
        .map(|n| n.id)
        .collect();

    let mut moved = 0u32;
    let mut failed = 0u32;
    for id in &note_ids {
        let tail = &id[prefix.len()..];
        let target = if parent.is_empty() {
            tail.to_string()
        } else {
            format!("{parent}/{tail}")
        };
        match rename_note(base, id, &target) {
            Ok(final_id) => {
                // Relink immediately per move, exactly like the desktop
                // `moveNote → rewriteWikilinksForRename` path.
                crate::wikilinks::relink_note_references(base, id, &final_id)?;
                moved += 1;
            }
            Err(_) => failed += 1,
        }
    }
    // CRITICAL (Tauri parity): never remove the tree while notes inside it
    // failed to move out — the orphans would go with it.
    if failed > 0 {
        return Err(format!(
            "folder not deleted — {failed} note(s) could not be moved out"
        ));
    }
    std::fs::remove_dir_all(&abs).map_err(|e| e.to_string())?;
    Ok(moved)
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
