//! Cross-platform filename, path, timestamp, and atomic-file primitives.
//!
//! This module deliberately owns no note workflow. It is the small safety
//! substrate used by the local-note store and by sync's raw file transport.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use filetime::{set_file_mtime, FileTime};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_TITLE_LENGTH: usize = 200;
pub const FALLBACK_TITLE: &str = "Untitled";
pub const MAX_FOLDER_DEPTH: usize = 10;
pub const NAME_MAX: usize = 255;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilenameIssueKind {
    ForbiddenChars,
    LeadingDots,
    TrailingDots,
    TooLong,
    Empty,
    ReservedName,
    CaseCollision,
    DepthExceeded,
}

impl FilenameIssueKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ForbiddenChars => "forbidden_chars",
            Self::LeadingDots => "leading_dots",
            Self::TrailingDots => "trailing_dots",
            Self::TooLong => "too_long",
            Self::Empty => "empty",
            Self::ReservedName => "reserved_name",
            Self::CaseCollision => "case_collision",
            Self::DepthExceeded => "depth_exceeded",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilenameIssue {
    pub kind: FilenameIssueKind,
    pub message: String,
}

const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn forbidden_title_character(character: char) -> bool {
    matches!(
        character,
        '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
    ) || character.is_control()
}

fn forbidden_path_character(character: char) -> bool {
    matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*') || character.is_control()
}

pub fn is_windows_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_uppercase();
    WINDOWS_RESERVED_NAMES.contains(&stem.as_str())
}

/// Strip characters that cannot round-trip as a filename on every supported
/// platform. Length is validated separately and is never silently truncated.
pub fn sanitize_title(title: &str) -> String {
    let filtered = title
        .chars()
        .filter(|character| !forbidden_title_character(*character))
        .collect::<String>();
    let stripped = filtered.trim().trim_matches('.').trim();
    if stripped.is_empty() {
        return FALLBACK_TITLE.to_owned();
    }
    if !is_windows_reserved_name(stripped) {
        return stripped.to_owned();
    }
    match stripped.find('.') {
        Some(dot) => format!("{}_{}", &stripped[..dot], &stripped[dot..]),
        None => format!("{stripped}_"),
    }
}

pub fn validate_title(title: &str) -> Vec<FilenameIssue> {
    if title.trim().is_empty() {
        return vec![FilenameIssue {
            kind: FilenameIssueKind::Empty,
            message: "Title cannot be empty".to_owned(),
        }];
    }

    let mut issues = Vec::new();
    if title.chars().any(forbidden_title_character) {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::ForbiddenChars,
            message: "That character can't be used in a note title".to_owned(),
        });
    }
    if title.starts_with('.') {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::LeadingDots,
            message: "Title cannot start with a dot".to_owned(),
        });
    }
    if title.ends_with('.') {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::TrailingDots,
            message: "Title cannot end with a dot".to_owned(),
        });
    }
    if title.encode_utf16().count() > MAX_TITLE_LENGTH {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::TooLong,
            message: format!("Title cannot exceed {MAX_TITLE_LENGTH} characters"),
        });
    }
    issues
}

pub fn is_valid_title(title: &str) -> bool {
    validate_title(title).is_empty()
}

fn valid_note_component(component: &str) -> bool {
    !component.is_empty()
        && component != "."
        && component != ".."
        && !component.chars().any(forbidden_path_character)
}

/// Validate a note ID: a forward-slash-separated path relative to the vault,
/// without the `.md` extension.
pub fn ensure_safe_note_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.starts_with('/') || id.ends_with('/') || id.contains('\\') {
        return Err("invalid note id".to_owned());
    }
    let components = id.split('/').collect::<Vec<_>>();
    if components.len().saturating_sub(1) > MAX_FOLDER_DEPTH {
        return Err("note id exceeds maximum folder depth".to_owned());
    }
    if components
        .iter()
        .any(|component| !valid_note_component(component))
    {
        return Err("invalid note id".to_owned());
    }
    Ok(())
}

pub fn safe_note_path(base: &Path, id: &str) -> Result<PathBuf, String> {
    ensure_safe_note_id(id)?;
    let mut components = id.split('/').collect::<Vec<_>>();
    let leaf = components.pop().expect("validated ID has a leaf");
    let mut path = base.to_owned();
    path.extend(components);
    path.push(format!("{leaf}.md"));
    Ok(path)
}

/// Build a descendant path using platform-neutral separators. Absolute paths,
/// drive prefixes, traversal, and empty components are refused before join.
pub fn safe_appdata_path(base: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() {
        return Err("path traversal blocked".to_owned());
    }
    let normalized = relative.replace('\\', "/");
    let looks_like_drive = normalized.as_bytes().get(1) == Some(&b':');
    if normalized.starts_with('/') || looks_like_drive {
        return Err("path traversal blocked".to_owned());
    }
    let components = normalized.split('/').collect::<Vec<_>>();
    if components
        .iter()
        .any(|component| component.is_empty() || *component == "." || *component == "..")
    {
        return Err("path traversal blocked".to_owned());
    }
    let mut path = base.to_owned();
    path.extend(components);
    Ok(path)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncomingSyncPath {
    Ignore,
    Accept,
    Sanitize(String),
    Reject(&'static str),
}

fn split_syncable_leaf(name: &str) -> (&str, &str) {
    if let Some(stem) = name.strip_suffix(".md") {
        return (stem, ".md");
    }
    name.rfind('.')
        .map(|dot| (&name[..dot], &name[dot..]))
        .unwrap_or((name, ""))
}

/// Decide whether an incoming peer path can be materialized exactly, needs a
/// deterministic cross-platform repair, must be ignored, or is unsafe.
pub fn classify_incoming_sync_path(relative: &str) -> IncomingSyncPath {
    use IncomingSyncPath::{Accept, Ignore, Reject, Sanitize};

    if relative.is_empty() {
        return Reject("empty path");
    }
    if !crate::image::is_syncable_filename(relative) {
        return Ignore;
    }

    let normalized = relative.replace('\\', "/");
    if normalized.starts_with('/') || normalized.ends_with('/') {
        return Reject("leading or trailing slash");
    }
    let components = normalized.split('/').collect::<Vec<_>>();
    if components.len().saturating_sub(1) > MAX_FOLDER_DEPTH {
        return Reject("exceeds maximum folder depth");
    }

    let last = components.len() - 1;
    let mut changed = false;
    let mut healed = Vec::with_capacity(components.len());
    for (index, component) in components.into_iter().enumerate() {
        if component.is_empty() || component == "." || component == ".." {
            return Reject("traversal or empty component");
        }
        if component.len() > NAME_MAX {
            return Reject("component exceeds filesystem name limit");
        }
        let (stem, extension) = if index == last {
            split_syncable_leaf(component)
        } else {
            (component, "")
        };
        if stem.chars().any(forbidden_path_character) {
            return Reject("forbidden character");
        }
        let safe_stem = sanitize_title(stem);
        changed |= safe_stem != stem;
        let safe_component = format!("{safe_stem}{extension}");
        if safe_component.len() > NAME_MAX {
            return Reject("component exceeds filesystem name limit");
        }
        healed.push(safe_component);
    }

    if changed {
        Sanitize(healed.join("/"))
    } else {
        Accept
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub fn mtime_or_now(modified_at: i64) -> i64 {
    if modified_at > 0 {
        modified_at
    } else {
        now_ms()
    }
}

pub fn file_mtime_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_else(now_ms)
}

pub fn set_file_mtime_ms(path: &Path, modified_at_ms: i64) -> Result<(), String> {
    let milliseconds = modified_at_ms.max(0);
    let time = FileTime::from_unix_time(
        milliseconds / 1000,
        ((milliseconds % 1000) * 1_000_000) as u32,
    );
    set_file_mtime(path, time).map_err(|error| error.to_string())
}

fn hidden_path(parent: &Path, purpose: &str) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        ".sf-{purpose}-{}-{}-{sequence}",
        std::process::id(),
        now_ms()
    ))
}

fn create_temp(parent: &Path) -> Result<(PathBuf, File), String> {
    for _ in 0..32 {
        let path = hidden_path(parent, "tmp");
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("{error} (creating temp {})", path.display())),
        }
    }
    Err("could not allocate an atomic-write temp file".to_owned())
}

fn matching_destination_files(parent: &Path, destination: &Path) -> Vec<PathBuf> {
    let Some(target) = destination.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    let key = crate::sync::collision_key(target);
    fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let path = entry.path();
            (path.is_file() && crate::sync::collision_key(name) == key).then_some(path)
        })
        .collect()
}

const BACKUP_PREFIX: &str = ".sf-bak-";
const BACKUP_SIDECAR_SUFFIX: &str = ".path";

fn sidecar_of(backup: &Path) -> PathBuf {
    let mut name = backup.as_os_str().to_owned();
    name.push(BACKUP_SIDECAR_SUFFIX);
    PathBuf::from(name)
}

fn park_destinations(parent: &Path, destination: &Path) -> Vec<(PathBuf, PathBuf)> {
    matching_destination_files(parent, destination)
        .into_iter()
        .filter_map(|original| {
            let backup = hidden_path(parent, "bak");
            let leaf = original.file_name()?.to_str()?.to_owned();
            // Write the recovery sidecar (original leaf name) BEFORE moving the
            // note out of the way, so a crash right after the park rename leaves
            // a backup whose sidecar can restore it. Without this the note is
            // stranded in a scan-ignored dotfile with no way back (A2).
            if fs::write(sidecar_of(&backup), leaf.as_bytes()).is_err() {
                return None;
            }
            match fs::rename(&original, &backup) {
                Ok(()) => Some((original, backup)),
                Err(_) => {
                    let _ = fs::remove_file(sidecar_of(&backup));
                    None
                }
            }
        })
        .collect()
}

/// Bootstrap recovery for a crash inside [`install_temp`]'s collision fallback:
/// a note parked to a hidden `.sf-bak-*` backup whose re-install never
/// completed. For each backup with a `.path` sidecar, restore it to the
/// recorded name when that name is now missing, or drop it when the name is
/// already present (the install had completed; only cleanup was interrupted).
/// Orphan sidecars (no backup) are removed. Recurses into subfolders because
/// notes — and thus parks — live throughout the tree. Best-effort: any single
/// failure is skipped, never fatal.
pub fn recover_parked_backups(root: &Path) {
    recover_parked_in(root, 0);
}

fn recover_parked_in(dir: &Path, depth: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut subdirs = Vec::new();
    let mut names = Vec::new();
    for entry in entries.flatten() {
        // symlink_metadata does NOT follow symlinks. A directory symlink back
        // into the vault (or a loop) would otherwise recurse to a stack
        // overflow at bootstrap and the app would never render (B1). Combined
        // with the depth bound below, this matches the note scanner's
        // follow_links(false) + max_depth walk.
        let real_dir = fs::symlink_metadata(entry.path())
            .map(|meta| meta.file_type().is_dir())
            .unwrap_or(false);
        if real_dir {
            subdirs.push(entry.path());
        } else if let Some(name) = entry.file_name().to_str() {
            if name.starts_with(BACKUP_PREFIX) {
                names.push(name.to_owned());
            }
        }
    }

    for name in names.iter().filter(|n| !n.ends_with(BACKUP_SIDECAR_SUFFIX)) {
        let backup = dir.join(name);
        let sidecar = dir.join(format!("{name}{BACKUP_SIDECAR_SUFFIX}"));
        let Ok(leaf) = fs::read_to_string(&sidecar) else {
            continue;
        };
        let leaf = leaf.trim();
        if leaf.is_empty() || leaf.contains('/') || leaf.contains('\\') {
            continue;
        }
        let destination = dir.join(leaf);
        // NO-REPLACE restore: `hard_link` fails EEXIST rather than overwriting,
        // so a note an external writer created in the window between an
        // existence check and the move can never be clobbered (B2 — the same
        // TOCTOU A1 closed). The temp link shares the inode; dropping the
        // backup completes the move.
        match fs::hard_link(&backup, &destination) {
            Ok(()) => {
                let _ = fs::remove_file(&backup);
                let _ = fs::remove_file(&sidecar);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // The name is taken. If the live note is byte-identical, the
                // note already returned — drop the stale backup. Otherwise a
                // different writer owns the name now; RETAIN the backup + its
                // sidecar rather than clobber, so no content is lost (the
                // data-preserving choice; a later sweep re-evaluates).
                match (fs::read(&backup), fs::read(&destination)) {
                    (Ok(backup_bytes), Ok(live_bytes)) if backup_bytes == live_bytes => {
                        let _ = fs::remove_file(&backup);
                        let _ = fs::remove_file(&sidecar);
                    }
                    _ => {}
                }
            }
            Err(_) => {}
        }
    }

    for name in names.iter().filter(|n| n.ends_with(BACKUP_SIDECAR_SUFFIX)) {
        let base = name.trim_end_matches(BACKUP_SIDECAR_SUFFIX);
        if !dir.join(base).exists() {
            let _ = fs::remove_file(dir.join(name));
        }
    }

    if depth < MAX_FOLDER_DEPTH {
        for subdir in subdirs {
            recover_parked_in(&subdir, depth + 1);
        }
    }
}

fn install_temp(temp: &Path, destination: &Path) -> Result<(), String> {
    let first_error = match fs::rename(temp, destination) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };

    let parent = destination
        .parent()
        .ok_or_else(|| "invalid file path".to_owned())?;
    let parked = park_destinations(parent, destination);
    if parked.is_empty() {
        return Err(format!(
            "{first_error} (renaming {} -> {})",
            temp.display(),
            destination.display()
        ));
    }

    if let Err(error) = fs::rename(temp, destination) {
        for (original, backup) in parked {
            let _ = fs::rename(&backup, original);
            let _ = fs::remove_file(sidecar_of(&backup));
        }
        return Err(format!(
            "{error} (installing {} after collision recovery)",
            destination.display()
        ));
    }
    for (_, backup) in parked {
        let _ = fs::remove_file(&backup);
        let _ = fs::remove_file(sidecar_of(&backup));
    }
    Ok(())
}

/// Write bytes to a same-directory temporary file, flush them, then atomically
/// replace the destination. Temp names stay short even for a 200-character
/// note title. Failed installs retain or restore the previous destination.
pub fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid file path".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid file name".to_owned())?;
    if name.len() > NAME_MAX {
        return Err("file name exceeds filesystem name limit".to_owned());
    }

    let (temp, mut file) = create_temp(parent)?;
    let write_result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("{error} (writing temp {})", temp.display()));
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }

    if let Err(error) = install_temp(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    // Directory fsync is supported on Unix and makes the rename durable. It is
    // best-effort because Windows does not open directories as ordinary files.
    let _ = File::open(parent).and_then(|directory| directory.sync_all());
    Ok(())
}

pub fn write_atomic_text(path: &Path, content: &str) -> Result<(), String> {
    write_atomic_bytes(path, content.as_bytes())
}

/// Atomically install `bytes` at `path` ONLY IF no file exists there yet — the
/// no-replace, content-complete-at-visibility sibling of [`write_atomic_bytes`].
/// Returns `true` if created, `false` if `path` (or, on a case-insensitive
/// filesystem, a case-variant) already held the name.
///
/// The full content is written to a sibling temp first, then `hard_link`ed into
/// place: `hard_link` is the portable atomic no-replace install (fails EEXIST
/// rather than overwriting, unlike `rename`), and because the destination name
/// only ever appears already pointing at the fully-written inode, a concurrent
/// scan/sync can never observe an empty or partial file. The temp is ALWAYS
/// dropped — on success, on EEXIST, and on error — so a failed install never
/// leaves a partial file that would wedge later attempts into EEXIST.
pub fn create_new_atomic(path: &Path, bytes: &[u8]) -> Result<bool, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid file path".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid file name".to_owned())?;
    if name.len() > NAME_MAX {
        return Err("file name exceeds filesystem name limit".to_owned());
    }

    let (temp, mut file) = create_temp(parent)?;
    let write_result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("{error} (writing temp {})", temp.display()));
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }

    let result = match fs::hard_link(&temp, path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(format!(
            "{error} (hard-linking {} -> {})",
            temp.display(),
            path.display()
        )),
    };
    // Always drop the temp: on success `path` is an independent link to the same
    // inode, so removing the temp leaves the content in place.
    let _ = fs::remove_file(&temp);
    result
}

pub fn read_blob_as_base64(path: &Path) -> Result<String, String> {
    fs::read(path)
        .map(|bytes| STANDARD.encode(bytes))
        .map_err(|error| error.to_string())
}

pub fn write_base64_as_blob(path: &Path, content: &str) -> Result<(), String> {
    let bytes = STANDARD
        .decode(content.as_bytes())
        .map_err(|error| format!("invalid base64 image content: {error}"))?;
    write_atomic_bytes(path, &bytes)
}

/// Force a case/normalization-only rename through a hidden entry. The source
/// is restored if the second hop fails.
pub fn rename_through_temp(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = source
        .parent()
        .ok_or_else(|| "invalid source path".to_owned())?;
    if let Some(destination_parent) = destination.parent() {
        fs::create_dir_all(destination_parent).map_err(|error| error.to_string())?;
    }
    let temp = hidden_path(parent, "tmp");
    fs::rename(source, &temp).map_err(|error| {
        format!(
            "{error} (renaming {} -> temp {})",
            source.display(),
            temp.display()
        )
    })?;
    if let Err(error) = fs::rename(&temp, destination) {
        let _ = fs::rename(&temp, source);
        return Err(format!(
            "{error} (renaming temp {} -> {})",
            temp.display(),
            destination.display()
        ));
    }
    Ok(())
}

pub fn note_id_from_filename(name: &str) -> Option<String> {
    let id = name.strip_suffix(".md")?;
    (!id.is_empty()).then(|| id.to_owned())
}

pub fn note_id_from_relative_path(relative: &str) -> Option<String> {
    let normalized = relative.replace('\\', "/");
    let id = normalized.strip_suffix(".md")?;
    ensure_safe_note_id(id).ok()?;
    Some(id.to_owned())
}

fn occupied_note_id(base: &Path, id: &str) -> Result<bool, String> {
    let path = safe_note_path(base, id)?;
    if path.exists() {
        return Ok(true);
    }
    let Some(parent) = path.parent() else {
        return Ok(false);
    };
    let Some(target) = path.file_name().and_then(|name| name.to_str()) else {
        return Ok(false);
    };
    let key = crate::sync::collision_key(target);
    Ok(fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .any(|name| crate::sync::collision_key(&name) == key))
}

pub fn get_unique_note_id(
    base: &Path,
    wanted: &str,
    exclude: Option<&str>,
) -> Result<String, String> {
    ensure_safe_note_id(wanted)?;
    if Some(wanted) == exclude || !occupied_note_id(base, wanted)? {
        return Ok(wanted.to_owned());
    }
    for suffix in 2u64.. {
        let candidate = format!("{wanted}-{suffix}");
        if Some(candidate.as_str()) == exclude || !occupied_note_id(base, &candidate)? {
            return Ok(candidate);
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static SEQUENCE: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "futo-notes-files-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    // A2: a crash after the collision-fallback park (note moved to a hidden
    // backup, re-install not yet done) leaves the note in a scan-ignored
    // dotfile. Bootstrap recovery restores it from its sidecar.
    #[test]
    fn recover_restores_a_note_stranded_in_a_parked_backup() {
        let root = temp_dir();
        fs::write(root.join(".sf-bak-1-2-3"), "stranded bytes").unwrap();
        fs::write(root.join(".sf-bak-1-2-3.path"), "Welcome.md").unwrap();
        assert!(!root.join("Welcome.md").exists());

        recover_parked_backups(&root);

        assert_eq!(
            fs::read_to_string(root.join("Welcome.md")).unwrap(),
            "stranded bytes",
            "the stranded note must be restored to its canonical name"
        );
        assert!(!root.join(".sf-bak-1-2-3").exists());
        assert!(!root.join(".sf-bak-1-2-3.path").exists());
    }

    // dest present with IDENTICAL content: the note genuinely returned, so the
    // stale duplicate backup is dropped.
    #[test]
    fn recover_drops_a_backup_identical_to_the_returned_note() {
        let root = temp_dir();
        fs::write(root.join(".sf-bak-9-9-9"), "same bytes").unwrap();
        fs::write(root.join(".sf-bak-9-9-9.path"), "Welcome.md").unwrap();
        fs::write(root.join("Welcome.md"), "same bytes").unwrap();

        recover_parked_backups(&root);

        assert_eq!(
            fs::read_to_string(root.join("Welcome.md")).unwrap(),
            "same bytes"
        );
        assert!(!root.join(".sf-bak-9-9-9").exists());
        assert!(!root.join(".sf-bak-9-9-9.path").exists());
    }

    // dest present with DIFFERENT content: a writer created the name in the
    // window, so recovery must NOT clobber it (the B2 TOCTOU) — it retains the
    // backup instead, and both contents survive.
    #[test]
    fn recover_retains_the_backup_when_a_different_note_holds_the_name() {
        let root = temp_dir();
        fs::write(root.join(".sf-bak-8-8-8"), "stranded original").unwrap();
        fs::write(root.join(".sf-bak-8-8-8.path"), "Welcome.md").unwrap();
        fs::write(root.join("Welcome.md"), "newcomer bytes").unwrap();

        recover_parked_backups(&root);

        assert_eq!(
            fs::read_to_string(root.join("Welcome.md")).unwrap(),
            "newcomer bytes",
            "the newcomer must never be clobbered"
        );
        assert_eq!(
            fs::read_to_string(root.join(".sf-bak-8-8-8")).unwrap(),
            "stranded original",
            "the stranded content must be preserved, not lost"
        );
        assert!(root.join(".sf-bak-8-8-8.path").exists());
    }

    // B1: a directory symlink back into the vault must not be followed — a loop
    // would recurse to a stack overflow at bootstrap. Recovery still restores a
    // real stranded backup.
    #[cfg(unix)]
    #[test]
    fn recover_does_not_follow_directory_symlinks_into_a_loop() {
        let root = temp_dir();
        fs::write(root.join(".sf-bak-1-1-1"), "loop-safe bytes").unwrap();
        fs::write(root.join(".sf-bak-1-1-1.path"), "Note.md").unwrap();
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();

        recover_parked_backups(&root); // must return, not stack-overflow

        assert_eq!(
            fs::read_to_string(root.join("Note.md")).unwrap(),
            "loop-safe bytes"
        );
    }

    // Boundary "after sidecar, before park": an orphan sidecar is harmless and
    // cleaned; and parks in subfolders are recovered (notes live tree-wide).
    #[test]
    fn recover_cleans_orphan_sidecars_and_recurses_into_folders() {
        let root = temp_dir();
        fs::write(root.join(".sf-bak-orphan.path"), "Ghost.md").unwrap();
        let sub = root.join("Folder");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join(".sf-bak-5-5-5"), "sub bytes").unwrap();
        fs::write(sub.join(".sf-bak-5-5-5.path"), "Deep.md").unwrap();

        recover_parked_backups(&root);

        assert!(!root.join(".sf-bak-orphan.path").exists());
        assert!(!root.join("Ghost.md").exists());
        assert_eq!(fs::read_to_string(sub.join("Deep.md")).unwrap(), "sub bytes");
        assert!(!sub.join(".sf-bak-5-5-5").exists());
    }

    #[test]
    fn title_rules_match_the_public_cross_platform_contract() {
        assert_eq!(sanitize_title(" ..CON.md.. "), "CON_.md");
        assert_eq!(sanitize_title("<>..."), FALLBACK_TITLE);
        assert_eq!(sanitize_title("café 1.4"), "café 1.4");
        assert!(is_windows_reserved_name("lpt9.txt"));

        let kinds = validate_title(".bad<name>.")
            .into_iter()
            .map(|issue| issue.kind)
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![
                FilenameIssueKind::ForbiddenChars,
                FilenameIssueKind::LeadingDots,
                FilenameIssueKind::TrailingDots,
            ]
        );
        assert!(validate_title(&"😀".repeat(MAX_TITLE_LENGTH / 2)).is_empty());
        assert_eq!(
            validate_title(&"😀".repeat(MAX_TITLE_LENGTH / 2 + 1))[0].kind,
            FilenameIssueKind::TooLong
        );
    }

    #[test]
    fn note_paths_preserve_layout_and_refuse_escape() {
        let base = Path::new("/vault");
        assert_eq!(
            safe_note_path(base, "Specs/v1.4 plan").unwrap(),
            PathBuf::from("/vault/Specs/v1.4 plan.md")
        );
        for unsafe_id in ["", "../note", "a//b", "a\\b", "/note", "a/./b"] {
            assert!(safe_note_path(base, unsafe_id).is_err(), "{unsafe_id}");
        }
        let too_deep = (0..MAX_FOLDER_DEPTH + 2)
            .map(|index| format!("d{index}"))
            .collect::<Vec<_>>()
            .join("/");
        assert!(ensure_safe_note_id(&too_deep).is_err());
    }

    #[test]
    fn appdata_paths_reject_unix_and_windows_traversal() {
        let base = Path::new("/appdata");
        assert_eq!(
            safe_appdata_path(base, "state/config.json").unwrap(),
            PathBuf::from("/appdata/state/config.json")
        );
        for unsafe_path in ["", "../x", "a/../../x", "a\\..\\x", "/x", "C:\\x"] {
            assert!(
                safe_appdata_path(base, unsafe_path).is_err(),
                "{unsafe_path}"
            );
        }
    }

    #[test]
    fn incoming_paths_have_one_accept_heal_ignore_reject_decision() {
        use IncomingSyncPath::*;
        assert_eq!(classify_incoming_sync_path("Folder/note.md"), Accept);
        assert_eq!(classify_incoming_sync_path("photo.PNG"), Accept);
        assert_eq!(classify_incoming_sync_path("scan.tiff"), Ignore);
        assert_eq!(
            classify_incoming_sync_path("CON.md"),
            Sanitize("CON_.md".to_owned())
        );
        assert_eq!(
            classify_incoming_sync_path("folder./note.md"),
            Sanitize("folder/note.md".to_owned())
        );
        assert!(matches!(
            classify_incoming_sync_path("../note.md"),
            Reject(_)
        ));
        assert!(matches!(
            classify_incoming_sync_path("a<bad>.md"),
            Reject(_)
        ));

        let healed = match classify_incoming_sync_path("CON.md") {
            Sanitize(path) => path,
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(classify_incoming_sync_path(&healed), Accept);
    }

    #[test]
    fn incoming_name_limit_is_bytes_not_ui_title_length() {
        use IncomingSyncPath::*;
        assert_eq!(
            classify_incoming_sync_path(&format!("{}.md", "a".repeat(220))),
            Accept
        );
        assert!(matches!(
            classify_incoming_sync_path(&format!("{}.md", "a".repeat(NAME_MAX))),
            Reject(_)
        ));
        assert!(matches!(
            classify_incoming_sync_path(&format!("{}.md", "界".repeat(90))),
            Reject(_)
        ));
    }

    #[test]
    fn atomic_text_write_replaces_content_without_temp_litter() {
        let root = temp_dir();
        let path = root.join(format!("{}.md", "a".repeat(MAX_TITLE_LENGTH)));
        write_atomic_text(&path, "first").unwrap();
        write_atomic_text(&path, "second\n😀").unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "second\n😀");
        assert!(fs::read_dir(&root).unwrap().flatten().all(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            !name.starts_with(".sf-tmp-") && !name.starts_with(".sf-bak-")
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binary_blob_round_trip_is_not_utf8_dependent() {
        let root = temp_dir();
        let source = root.join("source.png");
        let destination = root.join("destination.png");
        let bytes = [0, 159, 255, 13, 10, 42];
        write_atomic_bytes(&source, &bytes).unwrap();
        let encoded = read_blob_as_base64(&source).unwrap();
        write_base64_as_blob(&destination, &encoded).unwrap();
        assert_eq!(fs::read(destination).unwrap(), bytes);
        assert!(write_base64_as_blob(&root.join("bad.png"), "not base64!").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn temp_hop_changes_the_directory_entry_without_losing_bytes() {
        let root = temp_dir();
        let source = root.join("note.md");
        let destination = root.join("Note.md");
        fs::write(&source, "body").unwrap();
        rename_through_temp(&source, &destination).unwrap();
        assert_eq!(fs::read_to_string(destination).unwrap(), "body");
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .flatten()
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
                .count(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn note_id_parsing_is_strict_and_platform_neutral() {
        assert_eq!(note_id_from_filename("note.md"), Some("note".to_owned()));
        assert_eq!(note_id_from_filename("note.MD"), None);
        assert_eq!(note_id_from_filename(".md"), None);
        assert_eq!(
            note_id_from_relative_path("Folder\\note.md"),
            Some("Folder/note".to_owned())
        );
        assert_eq!(note_id_from_relative_path("../note.md"), None);
    }

    #[test]
    fn unique_ids_fold_case_and_unicode_normalization() {
        let root = temp_dir();
        fs::write(root.join("Café.md"), "one").unwrap();
        assert_eq!(
            get_unique_note_id(&root, "cafe\u{301}", None).unwrap(),
            "cafe\u{301}-2"
        );
        assert_eq!(
            get_unique_note_id(&root, "Café", Some("Café")).unwrap(),
            "Café"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn modification_time_round_trips_in_milliseconds() {
        let root = temp_dir();
        let path = root.join("note.md");
        fs::write(&path, "body").unwrap();
        set_file_mtime_ms(&path, 1_700_000_123_000).unwrap();
        let actual = file_mtime_ms(&fs::metadata(path).unwrap());
        assert!((actual - 1_700_000_123_000).abs() < 2_000);
        fs::remove_dir_all(root).unwrap();
    }
}
