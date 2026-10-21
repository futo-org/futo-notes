//! Turning a raw `notify` event into the kind of change it reports.

use super::*;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ChangeKind {
    Add,
    Change,
    Unlink,
    RenameFrom,
    RenameTo,
    /// One half of a rename that does not say which (macOS FSEvents).
    RenameEither,
}

pub(super) fn classify(event: &Event, mode: WatchMode) -> Option<ChangeKind> {
    match &event.kind {
        EventKind::Create(_) => Some(ChangeKind::Add),
        // The poll backend reports an edited file as a WriteTime metadata change
        // (notify's `poll::compare_to_event`) and reserves `Modify(Data)` for the
        // rarer same-mtime-different-content case. Native backends use WriteTime
        // for chmod/touch noise only, which is why this is mode-dependent: taking
        // it everywhere would make every `touch` a change, and dropping it under
        // poll would make the poll watcher blind to edits — the exact silence this
        // fallback exists to remove.
        EventKind::Modify(ModifyKind::Metadata(MetadataKind::WriteTime))
            if mode == WatchMode::Poll =>
        {
            Some(ChangeKind::Change)
        }
        EventKind::Modify(ModifyKind::Metadata(_)) => None,
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Some(ChangeKind::RenameFrom),
        EventKind::Modify(ModifyKind::Name(RenameMode::To | RenameMode::Both)) => {
            Some(ChangeKind::RenameTo)
        }
        // FSEvents has no rename cookie and does not say which half a path is:
        // notify reports both as `Name(Any)`, one event per path.
        EventKind::Modify(ModifyKind::Name(RenameMode::Any)) => Some(ChangeKind::RenameEither),
        EventKind::Modify(_) => Some(ChangeKind::Change),
        EventKind::Remove(_) => Some(ChangeKind::Unlink),
        _ => None,
    }
}

/// Whether anything is at `path` now, without following a symlink.
pub(super) fn path_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// The vault name of a changed note file (`.md`, or legacy `.txt`), or `None`
/// for anything that names no note: a hidden path, another extension, or a name
/// no note id can hold (a Unix `\`, bytes that are not UTF-8).
pub(super) fn relative_note_path(base: &Path, path: &Path) -> Option<String> {
    let name = vault_fs::relative_name(base, path)?;
    if name.split('/').any(|component| component.starts_with('.')) {
        return None;
    }
    let stem = name
        .strip_suffix(".md")
        .or_else(|| name.strip_suffix(".txt"))?;
    note_id_from_relative_path(&format!("{stem}.md"))?;
    Some(name)
}

pub(super) fn relative_note_path_any(bases: &[PathBuf], path: &Path) -> Option<String> {
    bases.iter().find_map(|base| relative_note_path(base, path))
}
