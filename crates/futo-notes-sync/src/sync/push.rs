use std::collections::{HashMap, HashSet};
use std::path::Path;

use futo_notes_core::files::{classify_incoming_sync_path, IncomingSyncPath};
use futo_notes_core::hash::hash_sha256;
use futo_notes_core::image::is_syncable_filename;

use crate::checkpoint::{self, ConnectedState, ObjectState};
use crate::server::{Http, Mutation};
use crate::session::connect::{client, collection_error};

use super::conflict_resolution::resolve_update_conflict;
use super::encrypted_note::{decrypt, encrypt, object_state, state_from_remote};
use super::outcome::{append_derived_renames, note_id, record_checkpoint_failure};
use super::tombstones::recover_stale_claims;
use super::vault::{local_files, read_content, write_content, LocalFile};
use super::vault_fs;
use super::{
    CycleFailure, FailureKind, PreWrite, Progress, RenamePair, SaveCheckpoint, SyncErrorKind,
    SyncFailure, SyncProgress, SyncSummary,
};

pub(super) struct Upload<'a> {
    pub(super) name: &'a str,
    pub(super) content: &'a str,
    pub(super) hash: String,
    pub(super) size: u64,
    pub(super) mtime: i64,
}

pub(super) async fn create_fresh(
    http: &Http,
    state: &mut ConnectedState,
    upload: Upload<'_>,
    summary: &mut SyncSummary,
) -> Option<ObjectState> {
    let ciphertext = match encrypt(&state.vault_key, upload.name, upload.content) {
        Ok(ciphertext) => ciphertext,
        Err(_) => {
            summary.failures.push(SyncFailure {
                filename: upload.name.into(),
                kind: FailureKind::Upload,
                status_code: None,
            });
            return None;
        }
    };
    match http.create_object(&state.collection_id, ciphertext).await {
        Ok(write) => {
            state.max_version = state.max_version.max(write.collection_version);
            state.oversize_skip.remove(upload.name);
            summary.uploaded += 1;
            Some(object_state(&write, upload.hash, upload.size))
        }
        Err(error) if error.is(413) => {
            state.oversize_skip.insert(upload.name.into(), upload.mtime);
            summary.conflicts += 1;
            None
        }
        Err(error) => {
            summary.failures.push(SyncFailure {
                filename: upload.name.into(),
                kind: FailureKind::Upload,
                status_code: error.status,
            });
            None
        }
    }
}

pub(super) struct PushContext<'a> {
    pub(super) http: &'a Http,
    pub(super) state: &'a mut ConnectedState,
    pub(super) root: &'a Path,
    pub(super) summary: &'a mut SyncSummary,
    pub(super) pre_write: &'a PreWrite,
}

async fn update_existing(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
    content: &str,
    hash: String,
    local_was_rename: bool,
) -> Option<(String, ObjectState)> {
    let ciphertext = match encrypt(&context.state.vault_key, &file.name, content) {
        Ok(ciphertext) => ciphertext,
        Err(_) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: None,
            });
            return None;
        }
    };
    match context
        .http
        .update_object(
            &context.state.collection_id,
            &existing.object_id,
            existing.version + 1,
            ciphertext,
        )
        .await
    {
        Ok(Mutation::Written(write)) if write.object.deleted => create_fresh(
            context.http,
            context.state,
            Upload {
                name: &file.name,
                content,
                hash,
                size: file.size,
                mtime: file.mtime,
            },
            context.summary,
        )
        .await
        .map(|state| (file.name.clone(), state)),
        Ok(Mutation::Written(write)) => {
            context.state.max_version = context.state.max_version.max(write.collection_version);
            context.state.oversize_skip.remove(&file.name);
            context.summary.uploaded += 1;
            Some((file.name.clone(), object_state(&write, hash, file.size)))
        }
        Ok(Mutation::Conflict(conflict)) => {
            resolve_update_conflict(
                context,
                file,
                existing,
                content,
                hash,
                conflict,
                local_was_rename,
            )
            .await
        }
        Err(error) if error.is(413) => {
            context
                .state
                .oversize_skip
                .insert(file.name.clone(), file.mtime);
            context.summary.conflicts += 1;
            None
        }
        Err(error) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: error.status,
            });
            None
        }
    }
}

fn missing_local_files(state: &ConnectedState, files: &[LocalFile]) -> Vec<(String, ObjectState)> {
    let local_names: HashSet<_> = files.iter().map(|file| file.name.as_str()).collect();
    state
        .object_map
        .iter()
        .filter(|(name, _)| !local_names.contains(name.as_str()))
        .map(|(name, entry)| (name.clone(), entry.clone()))
        .collect()
}

fn unique_rename_candidate<'a>(
    missing: &'a [(String, ObjectState)],
    claimed_missing: &HashSet<String>,
    basename: &str,
    hash: &str,
) -> Option<&'a (String, ObjectState)> {
    let mut candidates = missing.iter().filter(|(old, entry)| {
        !claimed_missing.contains(old)
            && entry.hash.as_deref() == Some(hash)
            && old.rsplit('/').next().unwrap_or(old) == basename
    });
    let candidate = candidates.next()?;
    candidates.next().is_none().then_some(candidate)
}

fn detect_local_renames(
    state: &mut ConnectedState,
    root: &Path,
    files: &[LocalFile],
    missing: &[(String, ObjectState)],
    summary: &mut SyncSummary,
) -> Result<(HashSet<String>, HashSet<String>), String> {
    let unmapped: Vec<_> = files
        .iter()
        .filter(|file| !state.object_map.contains_key(&file.name))
        .collect();
    let mut hashes = HashMap::new();
    for file in &unmapped {
        let content = read_content(root, &file.name)?;
        hashes.insert(file.name.as_str(), hash_sha256(&content));
    }
    let mut claimed_missing = HashSet::new();
    let mut renamed_files = HashSet::new();

    for file in unmapped {
        let Some(hash) = hashes.get(file.name.as_str()) else {
            continue;
        };
        let basename = file.name.rsplit('/').next().unwrap_or(&file.name);
        let Some((old, entry)) = unique_rename_candidate(missing, &claimed_missing, basename, hash)
        else {
            continue;
        };

        state.object_map.remove(old);
        state.object_map.insert(file.name.clone(), entry.clone());
        claimed_missing.insert(old.clone());
        renamed_files.insert(file.name.clone());
        summary.renamed.push(RenamePair {
            from_id: note_id(old),
            to_id: note_id(&file.name),
        });
    }

    Ok((claimed_missing, renamed_files))
}

fn reuse_unchanged_object(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
    hash: &str,
    renamed: bool,
) -> bool {
    if renamed || existing.hash.as_deref() != Some(hash) {
        return false;
    }
    if let Some(server_mtime) = existing.mtime_ms {
        if server_mtime != file.mtime {
            (context.pre_write)(&file.name);
            let _ = vault_fs::set_mtime_ms(context.root, &file.name, server_mtime);
        }
    }
    let mut entry = existing.clone();
    entry.size_bytes = Some(file.size);
    context.state.object_map.insert(file.name.clone(), entry);
    true
}

async fn push_local_file(mut context: PushContext<'_>, file: &LocalFile, renamed: bool) -> bool {
    if context.state.oversize_skip.get(&file.name) == Some(&file.mtime) {
        context.summary.conflicts += 1;
        return false;
    }
    let existing = context.state.object_map.get(&file.name).cloned();
    if !renamed
        && existing.as_ref().is_some_and(|entry| {
            entry.mtime_ms == Some(file.mtime) && entry.size_bytes == Some(file.size)
        })
    {
        return false;
    }
    let content = match read_content(context.root, &file.name) {
        Ok(content) => content,
        Err(_) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: None,
            });
            return false;
        }
    };
    let hash = hash_sha256(&content);
    if existing
        .as_ref()
        .is_some_and(|entry| reuse_unchanged_object(&mut context, file, entry, &hash, renamed))
    {
        return false;
    }
    let result = match existing.as_ref() {
        Some(entry) => update_existing(&mut context, file, entry, &content, hash, renamed).await,
        None => create_fresh(
            context.http,
            context.state,
            Upload {
                name: &file.name,
                content: &content,
                hash,
                size: file.size,
                mtime: file.mtime,
            },
            context.summary,
        )
        .await
        .map(|state| (file.name.clone(), state)),
    };
    if let Some((target, entry)) = result {
        if let Some(modified) = entry.mtime_ms {
            (context.pre_write)(&target);
            let _ = vault_fs::set_mtime_ms(context.root, &target, modified);
        }
        if target != file.name {
            context.state.object_map.remove(&file.name);
        }
        context.state.object_map.insert(target, entry);
    }
    true
}

fn checkpoint_progress(
    root: &Path,
    state: &ConnectedState,
    summary: &mut SyncSummary,
    completed: usize,
    save_checkpoint: &SaveCheckpoint,
) {
    if completed % 50 == 0 && save_checkpoint(root, state).is_err() {
        record_checkpoint_failure(summary);
    }
}

fn eligible_deletions(
    missing: Vec<(String, ObjectState)>,
    claimed_missing: &HashSet<String>,
    state: &ConnectedState,
) -> Vec<(String, ObjectState)> {
    missing
        .into_iter()
        .filter(|(name, _)| !claimed_missing.contains(name))
        .filter(|(name, _)| is_syncable_filename(name))
        .filter_map(|(name, _)| {
            state
                .object_map
                .get(&name)
                .cloned()
                .map(|entry| (name, entry))
        })
        .collect()
}

async fn apply_delete_conflict(
    context: &mut PushContext<'_>,
    name: &str,
    entry: &ObjectState,
) -> Result<(), SyncErrorKind> {
    let current = context
        .http
        .object(&context.state.collection_id, &entry.object_id)
        .await
        .map_err(collection_error)?;
    let Ok(remote) = decrypt(context.http, &context.state.vault_key, &current).await else {
        return Ok(());
    };
    let target = match classify_incoming_sync_path(&remote.name) {
        IncomingSyncPath::Accept => remote.name.clone(),
        IncomingSyncPath::Sanitize(name) => name,
        _ => name.to_owned(),
    };
    write_content(context.root, &target, &remote.content, context.pre_write)
        .map_err(SyncErrorKind::Io)?;
    let remote_state = state_from_remote(&remote);
    if let Some(mtime) = remote_state.mtime_ms {
        let _ = vault_fs::set_mtime_ms(context.root, &target, mtime);
    }
    context.state.object_map.remove(name);
    context
        .state
        .object_map
        .insert(target.clone(), remote_state);
    context.summary.downloaded += 1;
    context.summary.conflicts += 1;
    context.summary.local_writes_applied += 1;
    context.summary.peer_updated_ids.push(note_id(&target));
    Ok(())
}

async fn delete_missing_objects(
    http: &Http,
    state: &mut ConnectedState,
    root: &Path,
    missing: Vec<(String, ObjectState)>,
    claimed_missing: &HashSet<String>,
    pre_write: &PreWrite,
    summary: &mut SyncSummary,
) -> Result<(), SyncErrorKind> {
    let mut context = PushContext {
        http,
        state,
        root,
        summary,
        pre_write,
    };
    let deleted = eligible_deletions(missing, claimed_missing, context.state);

    for (name, entry) in deleted {
        match context
            .http
            .delete_object(
                &context.state.collection_id,
                &entry.object_id,
                entry.version,
            )
            .await
        {
            Ok(Mutation::Written(write)) => {
                context.state.max_version = context.state.max_version.max(write.collection_version);
                context.state.object_map.remove(&name);
                context.summary.deleted += 1;
                context.summary.deleted_ids.push(note_id(&name));
            }
            Ok(Mutation::Conflict(_)) => {
                apply_delete_conflict(&mut context, &name, &entry).await?;
            }
            Err(error) => context.summary.failures.push(SyncFailure {
                filename: name,
                kind: FailureKind::Delete,
                status_code: error.status,
            }),
        }
    }
    Ok(())
}

pub(crate) async fn push(
    state: &ConnectedState,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    push_with_checkpoint(state, root, progress, pre_write, &checkpoint::save)
        .await
        .map_err(|failure| failure.kind)
}

pub(crate) async fn push_with_checkpoint(
    state: &ConnectedState,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
    save_checkpoint: &SaveCheckpoint,
) -> Result<(SyncSummary, ConnectedState), CycleFailure> {
    recover_stale_claims(root, pre_write);
    let files = local_files(root).map_err(|error| CycleFailure {
        kind: SyncErrorKind::Io(error),
        state: state.clone(),
    })?;
    let http = client(state).map_err(|kind| CycleFailure {
        kind,
        state: state.clone(),
    })?;
    let mut next = state.clone();
    let missing = missing_local_files(&next, &files);
    let mut summary = SyncSummary::default();
    let (claimed_missing, renamed_files) =
        detect_local_renames(&mut next, root, &files, &missing, &mut summary).map_err(|error| {
            CycleFailure {
                kind: SyncErrorKind::Io(error),
                state: next.clone(),
            }
        })?;

    progress(SyncProgress {
        phase: "pushing",
        current: 0,
        total: files.len() + missing.len(),
    });
    for (index, file) in files.iter().enumerate() {
        let report_progress = push_local_file(
            PushContext {
                http: &http,
                state: &mut next,
                root,
                summary: &mut summary,
                pre_write,
            },
            file,
            renamed_files.contains(&file.name),
        )
        .await;
        let completed = index + 1;
        if report_progress {
            progress(SyncProgress {
                phase: "pushing",
                current: completed,
                total: files.len() + missing.len(),
            });
            checkpoint_progress(root, &next, &mut summary, completed, save_checkpoint);
        }
    }
    if let Err(kind) = delete_missing_objects(
        &http,
        &mut next,
        root,
        missing,
        &claimed_missing,
        pre_write,
        &mut summary,
    )
    .await
    {
        return Err(CycleFailure { kind, state: next });
    }
    append_derived_renames(&mut summary, &state.object_map, &next.object_map);
    if save_checkpoint(root, &next).is_err() {
        record_checkpoint_failure(&mut summary);
    }
    Ok((summary, next))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "futo-sync-push-test-{}-{n}",
                futo_notes_core::files::now_ms()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn no_progress(_: SyncProgress) {}

    fn no_pre_write(_: &str) {}

    fn connected() -> ConnectedState {
        ConnectedState {
            base_url: "http://127.0.0.1:1".into(),
            token: "token".into(),
            user_id: "user".into(),
            collection_id: "collection".into(),
            vault_key: [5; 32],
            object_map: HashMap::new(),
            max_version: 0,
            pull_cursor: 0,
            oversize_skip: HashMap::new(),
        }
    }

    fn mutation_server() -> (String, Arc<AtomicUsize>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let mutations = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&mutations);
        let handle = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(1);
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0; 4096];
                        let read = stream.read(&mut request).unwrap_or(0);
                        if request[..read].starts_with(b"DELETE ") {
                            observed.fetch_add(1, Ordering::Relaxed);
                        }
                        let body = r#"{"error":"injected"}"#;
                        write!(
                            stream,
                            "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .unwrap();
                        return;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("mutation server failed: {error}"),
                }
            }
        });
        (format!("http://{address}"), mutations, handle)
    }

    #[tokio::test]
    async fn incomplete_root_scan_stops_before_remote_deletion() {
        let root = TempRoot::new();
        std::fs::remove_dir(root.path()).unwrap();
        let (base_url, mutations, server) = mutation_server();
        let mut state = connected();
        state.base_url = base_url;
        state.object_map.insert(
            "healthy.md".into(),
            ObjectState {
                object_id: "healthy-object".into(),
                version: 1,
                blob_key: "healthy-blob".into(),
                hash: Some(hash_sha256("healthy")),
                mtime_ms: Some(1),
                size_bytes: Some(7),
            },
        );

        let result = push(&state, root.path(), &no_progress, &no_pre_write).await;
        server.join().unwrap();

        assert!(matches!(result, Err(SyncErrorKind::Io(_))));
        assert_eq!(mutations.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn rename_read_failure_stops_before_remote_deletion() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("note.md"), [0xff]).unwrap();
        let (base_url, mutations, server) = mutation_server();
        let mut state = connected();
        state.base_url = base_url;
        state.object_map.insert(
            "folder/note.md".into(),
            ObjectState {
                object_id: "healthy-object".into(),
                version: 1,
                blob_key: "healthy-blob".into(),
                hash: Some(hash_sha256("healthy")),
                mtime_ms: Some(1),
                size_bytes: Some(7),
            },
        );

        let result = push(&state, root.path(), &no_progress, &no_pre_write).await;
        server.join().unwrap();

        assert!(matches!(result, Err(SyncErrorKind::Io(_))));
        assert_eq!(mutations.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn push_skips_an_oversize_flagged_file_without_uploading_or_deleting_it() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("big.md"), "too big for the server").unwrap();
        let file = local_files(root.path()).unwrap().remove(0);
        let mut state = connected();
        state.oversize_skip.insert(file.name.clone(), file.mtime);

        let (summary, next) = push(&state, root.path(), &no_progress, &no_pre_write)
            .await
            .unwrap();

        assert_eq!(summary.uploaded, 0);
        assert_eq!(summary.conflicts, 1);
        assert!(summary.failures.is_empty());
        assert!(root.path().join("big.md").exists());
        assert!(!next.object_map.contains_key(&file.name));
    }

    #[tokio::test]
    async fn push_retries_an_oversize_flagged_file_after_its_mtime_changes() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("big.md"), "shrunk").unwrap();
        let file = local_files(root.path()).unwrap().remove(0);
        let mut state = connected();
        state
            .oversize_skip
            .insert(file.name.clone(), file.mtime - 1);

        let (summary, _) = push(&state, root.path(), &no_progress, &no_pre_write)
            .await
            .unwrap();

        assert_eq!(summary.conflicts, 0);
        assert!(summary
            .failures
            .iter()
            .any(|failure| failure.kind == FailureKind::Upload));
        assert!(root.path().join("big.md").exists());
    }

    #[tokio::test]
    async fn push_preserves_the_pull_cursor() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("note.md"), "synced body").unwrap();
        let file = local_files(root.path()).unwrap().remove(0);
        let mut state = connected();
        state.pull_cursor = 42;
        state.max_version = 99;
        state.object_map.insert(
            file.name.clone(),
            ObjectState {
                object_id: "o1".into(),
                version: 1,
                blob_key: "bk".into(),
                hash: Some(hash_sha256("synced body")),
                mtime_ms: Some(file.mtime),
                size_bytes: Some(file.size),
            },
        );

        let (summary, next) = push(&state, root.path(), &no_progress, &no_pre_write)
            .await
            .unwrap();

        assert!(summary.failures.is_empty());
        assert_eq!(summary.uploaded, 0);
        assert_eq!(next.pull_cursor, 42);
    }
}
