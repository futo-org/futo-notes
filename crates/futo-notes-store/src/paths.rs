use std::collections::HashSet;
use std::path::{Path, PathBuf};

use futo_notes_core::files::{collision_key, ensure_safe_note_id, safe_note_path};

pub(crate) fn unique_note_id(
    root: &Path,
    wanted: &str,
    exclude: Option<&str>,
) -> Result<String, String> {
    ensure_safe_note_id(wanted)?;
    let occupied = crate::vault::note_paths(root)
        .into_iter()
        .map(|(id, _)| id)
        .filter(|id| Some(id.as_str()) != exclude)
        .collect::<HashSet<_>>();
    Ok(unique_against(wanted, &occupied))
}

pub(crate) fn unique_against(wanted: &str, occupied: &HashSet<String>) -> String {
    let keys: HashSet<String> = occupied.iter().map(|id| collision_key(id)).collect();
    if !keys.contains(&collision_key(wanted)) {
        return wanted.to_owned();
    }
    for suffix in 2u64.. {
        let candidate = format!("{wanted}-{suffix}");
        if !keys.contains(&collision_key(&candidate)) {
            return candidate;
        }
    }
    unreachable!()
}

/// Whether `candidate` is `wanted` itself or one of the numeric collision
/// suffixes `unique_against` mints (`<wanted>-2`, `<wanted>-3`, ...). Kept
/// beside `unique_against` so the `-<n>` suffix format lives in one place — used
/// to recognise a note a park of `wanted` could have produced WITHOUT matching a
/// merely similarly-named note ("<wanted> draft"), which `starts_with` did.
pub(crate) fn is_unique_variant(wanted: &str, candidate: &str) -> bool {
    candidate == wanted
        || candidate
            .strip_prefix(wanted)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

pub(crate) fn folder_path(root: &Path, folder: &str) -> Result<PathBuf, String> {
    if folder.is_empty()
        || folder.contains('\\')
        || folder.starts_with('/')
        || folder.ends_with('/')
    {
        return Err("invalid folder path".to_owned());
    }
    let components = folder.split('/').collect::<Vec<_>>();
    if components.len() > futo_notes_core::files::MAX_FOLDER_DEPTH
        || components
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
        || !futo_notes_model::validate_folder_path(folder).is_empty()
    {
        return Err("invalid folder path".to_owned());
    }
    let mut path = root.to_owned();
    for component in components {
        path.push(component);
    }
    Ok(path)
}

pub(crate) fn note_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    safe_note_path(root, id)
}
