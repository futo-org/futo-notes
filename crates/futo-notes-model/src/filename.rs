//! Folder-name and folder-path rules, layered on `core::files`'s title
//! primitives. Ported bit-for-bit from `packages/shared/src/filename.ts`.

use futo_notes_core::files::{validate_title, FilenameIssue, FilenameIssueKind, MAX_FOLDER_DEPTH};

/// Windows reserved device names. Matched case-insensitively. Enforced on
/// every platform so a vault created on macOS/Linux still syncs cleanly to a
/// Windows client. Matches `WINDOWS_RESERVED_NAMES` in `filename.ts`.
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

/// Validate a single folder name (one path component): the same
/// character/length/dots rules as a title, plus Windows-reserved rejection.
/// Mirrors TS `validateFolderName`.
pub fn validate_folder_name(name: &str) -> Vec<FilenameIssue> {
    let mut issues = validate_title(name);
    if is_windows_reserved_name(name) {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::ReservedName,
            message: format!(
                "\"{name}\" is reserved on Windows and cannot be used as a folder name"
            ),
        });
    }
    issues
}

/// Convenience: true if the folder name has no validation issues.
pub fn is_valid_folder_name(name: &str) -> bool {
    validate_folder_name(name).is_empty()
}

/// True if `name` collides case-insensitively with any existing sibling.
/// Mirrors TS `hasCaseInsensitiveSiblingCollision`.
pub fn has_case_insensitive_sibling_collision<I, S>(name: &str, siblings: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let lower = name.to_lowercase();
    siblings
        .into_iter()
        .any(|s| s.as_ref().to_lowercase() == lower)
}

/// Trim leading/trailing `/` runs (TS: `relPath.replace(/^\/+|\/+$/g, '')`).
fn trim_slashes(rel_path: &str) -> &str {
    rel_path.trim_matches('/')
}

/// Validate a relative folder path: each component a valid folder name, total
/// depth ≤ `MAX_FOLDER_DEPTH`, no `.` / `..` / empty components. Mirrors TS
/// `validateFolderPath` — including issue order: a single `depth_exceeded`
/// first, then per-component issues in order.
pub fn validate_folder_path(rel_path: &str) -> Vec<FilenameIssue> {
    let mut issues = Vec::new();
    let trimmed = trim_slashes(rel_path);
    if trimmed.is_empty() {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::Empty,
            message: "Folder path cannot be empty".to_string(),
        });
        return issues;
    }
    let components: Vec<&str> = trimmed.split('/').collect();
    if components.len() > MAX_FOLDER_DEPTH {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::DepthExceeded,
            message: format!("Folder depth cannot exceed {MAX_FOLDER_DEPTH}"),
        });
    }
    for component in components {
        if component.is_empty() || component == "." || component == ".." {
            issues.push(FilenameIssue {
                kind: FilenameIssueKind::ForbiddenChars,
                message: "Folder path contains an invalid component".to_string(),
            });
            continue;
        }
        issues.extend(validate_folder_name(component));
    }
    issues
}

/// Convenience: true if the relative folder path is valid.
pub fn is_valid_folder_path(rel_path: &str) -> bool {
    validate_folder_path(rel_path).is_empty()
}

/// Folder depth of a relative path: the number of folder components above the
/// leaf (a flat note is depth 0). `rel_path` excludes the `.md` extension.
/// Mirrors TS `pathDepth`.
pub fn path_depth(rel_path: &str) -> usize {
    let trimmed = trim_slashes(rel_path);
    if trimmed.is_empty() {
        return 0;
    }
    let count = trimmed.split('/').count();
    count.saturating_sub(1)
}
