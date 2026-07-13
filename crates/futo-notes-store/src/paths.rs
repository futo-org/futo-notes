use std::collections::HashSet;
use std::path::{Path, PathBuf};

use futo_notes_core::files::{ensure_safe_note_id, safe_note_path};
use futo_notes_core::sync::collision_key;

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
