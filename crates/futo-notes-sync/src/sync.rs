use std::collections::{HashMap, HashSet};
use std::path::Path;

use futo_notes_core::e2ee::{
    self, collision_conflict_filename, collision_key, conflict_filename, MergeResult,
};
use futo_notes_core::files::{
    classify_incoming_sync_path, file_mtime_ms, read_blob_as_base64, set_file_mtime_ms,
    write_atomic_text, write_base64_as_blob, IncomingSyncPath,
};
use futo_notes_core::hash::hash_sha256;
use futo_notes_core::image::{is_image_filename, is_syncable_filename};

use crate::http::{timestamp_ms, Conflict, Http, HttpError, Mutation, Object, Write};
use crate::store::{self, Ancestry, ConnectedState, ObjectState};

pub type Progress = dyn Fn(SyncProgress) + Send + Sync;
pub type PreWrite = dyn Fn(&str) + Send + Sync;

#[derive(Debug, Clone)]
pub struct ConnectInfo {
    pub user_id: String,
    pub collection_id: String,
    pub token: String,
    pub auth_mode: String,
}

#[derive(Debug, Clone, Copy)]
pub struct SyncProgress {
    pub phase: &'static str,
    pub current: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Upload,
    Delete,
    Checkpoint,
    Download,
    Decrypt,
    Rejected,
}

impl FailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Delete => "delete",
            Self::Checkpoint => "checkpoint",
            Self::Download => "download",
            Self::Decrypt => "decrypt",
            Self::Rejected => "rejected",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SyncFailure {
    pub filename: String,
    pub kind: FailureKind,
    pub status_code: Option<u16>,
}

#[derive(Debug, Clone)]
pub struct RenamePair {
    pub from_id: String,
    pub to_id: String,
}

#[derive(Debug, Default, Clone)]
pub struct SyncSummary {
    pub uploaded: u32,
    pub downloaded: u32,
    pub deleted: u32,
    pub conflicts: u32,
    pub local_writes_applied: u32,
    pub failures: Vec<SyncFailure>,
    pub updated_ids: Vec<String>,
    pub deleted_ids: Vec<String>,
    pub peer_updated_ids: Vec<String>,
    pub peer_deleted_ids: Vec<String>,
    pub renamed: Vec<RenamePair>,
}

impl SyncSummary {
    pub fn failure_message(&self) -> Option<String> {
        let server: Vec<_> = self
            .failures
            .iter()
            .filter(|f| matches!(f.kind, FailureKind::Upload | FailureKind::Delete))
            .collect();
        let count = |kind| self.failures.iter().filter(|f| f.kind == kind).count();
        let mut parts = Vec::new();
        if !server.is_empty() {
            let noun = if server.len() == 1 {
                "change"
            } else {
                "changes"
            };
            let mut message = format!("{} {noun} couldn't reach the server", server.len());
            let mut frequencies = Vec::<(u16, usize)>::new();
            for status in server.iter().filter_map(|f| f.status_code) {
                if let Some((_, n)) = frequencies.iter_mut().find(|(s, _)| *s == status) {
                    *n += 1;
                } else {
                    frequencies.push((status, 1));
                }
            }
            let status = frequencies
                .into_iter()
                .enumerate()
                .max_by_key(|(index, (_, count))| (*count, std::cmp::Reverse(*index)))
                .map(|(_, (status, _))| status);
            if let Some(status) = status {
                message.push_str(&format!(" (HTTP {status})"));
            }
            parts.push(message);
        }
        for (kind, singular, plural) in [
            (
                FailureKind::Download,
                "note couldn't be downloaded (will retry)",
                "notes couldn't be downloaded (will retry)",
            ),
            (
                FailureKind::Decrypt,
                "note couldn't be decrypted",
                "notes couldn't be decrypted",
            ),
            (
                FailureKind::Rejected,
                "note had an unsupported name and was skipped",
                "notes had unsupported names and were skipped",
            ),
        ] {
            let n = count(kind);
            if n > 0 {
                parts.push(format!("{n} {}", if n == 1 { singular } else { plural }));
            }
        }
        if count(FailureKind::Checkpoint) > 0 {
            parts.push("sync state couldn't be saved locally".into());
        }
        (!parts.is_empty()).then(|| parts.join("; "))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SyncErrorKind {
    #[error("{0}")]
    Http(String),
    #[error("{0}")]
    Auth(String),
    #[error("{0}")]
    Crypto(String),
    #[error("{0}")]
    Io(String),
    #[error("collection-gone: {0}")]
    CollectionGone(String),
    #[error("not connected")]
    NotConnected,
}

impl SyncErrorKind {
    pub fn message(&self) -> String {
        self.to_string()
    }
}

impl From<SyncErrorKind> for String {
    fn from(error: SyncErrorKind) -> Self {
        error.to_string()
    }
}

fn http_error(error: HttpError) -> SyncErrorKind {
    SyncErrorKind::Http(error.to_string())
}

fn collection_error(error: HttpError) -> SyncErrorKind {
    if error.is(404) {
        SyncErrorKind::CollectionGone(error.to_string())
    } else {
        http_error(error)
    }
}

pub(crate) async fn connect(
    root: &Path,
    server: &str,
    password: &str,
) -> Result<(ConnectedState, ConnectInfo), SyncErrorKind> {
    let anonymous = Http::new(server).map_err(http_error)?;
    let auth_mode = anonymous.auth_mode().await.map_err(http_error)?;
    let (user_id, token) = anonymous
        .login(&auth_mode, password)
        .await
        .map_err(|e| SyncErrorKind::Auth(e.to_string()))?;
    let http = anonymous.token(token.clone());
    let collection_id = match http.collections().await.map_err(http_error)?.first() {
        Some(id) => id.clone(),
        None => http.create_collection().await.map_err(http_error)?,
    };
    let material = match http.key(&collection_id).await.map_err(collection_error)? {
        Some(material) => material,
        None => {
            if !http
                .objects(&collection_id, 0)
                .await
                .map_err(collection_error)?
                .is_empty()
            {
                return Err(SyncErrorKind::Crypto(
                    "collection has objects but no key material; refusing to mint a new vault key"
                        .into(),
                ));
            }
            let password = password.to_owned();
            let (_, fresh) = tokio::task::spawn_blocking(move || e2ee::wrap_vault_key(&password))
                .await
                .map_err(|e| SyncErrorKind::Crypto(e.to_string()))?
                .map_err(|e| SyncErrorKind::Crypto(e.to_string()))?;
            http.put_key(&collection_id, &fresh)
                .await
                .map_err(collection_error)?
        }
    };
    let password = password.to_owned();
    let material_for_unlock = material.clone();
    let vault_key = tokio::task::spawn_blocking(move || {
        e2ee::unwrap_vault_key(&password, &material_for_unlock)
    })
    .await
    .map_err(|e| SyncErrorKind::Crypto(e.to_string()))?
    .map_err(|e| SyncErrorKind::Crypto(e.to_string()))?;
    let loaded = store::load(root, &collection_id);
    let state = ConnectedState {
        base_url: server.trim().trim_end_matches('/').to_owned(),
        token: token.clone(),
        user_id: user_id.clone(),
        collection_id: collection_id.clone(),
        vault_key,
        object_map: loaded.object_map,
        max_version: loaded.max_version,
        pull_cursor: loaded.pull_cursor,
        oversize_skip: HashMap::new(),
    };
    store::save(root, &state).map_err(SyncErrorKind::Io)?;
    Ok((
        state,
        ConnectInfo {
            user_id,
            collection_id,
            token,
            auth_mode,
        },
    ))
}

pub(crate) async fn resume(
    root: &Path,
    server: &str,
    token: &str,
    user_id: &str,
    collection_id: &str,
    password: &str,
) -> Result<ConnectedState, SyncErrorKind> {
    let http = Http::new(server).map_err(http_error)?.token(token);
    let material = http
        .key(collection_id)
        .await
        .map_err(collection_error)?
        .ok_or_else(|| SyncErrorKind::Crypto("vault key material missing on server".into()))?;
    let password = password.to_owned();
    let vault_key =
        tokio::task::spawn_blocking(move || e2ee::unwrap_vault_key(&password, &material))
            .await
            .map_err(|e| SyncErrorKind::Crypto(e.to_string()))?
            .map_err(|e| SyncErrorKind::Crypto(e.to_string()))?;
    let loaded = store::load(root, collection_id);
    Ok(ConnectedState {
        base_url: server.trim().trim_end_matches('/').to_owned(),
        token: token.to_owned(),
        user_id: user_id.to_owned(),
        collection_id: collection_id.to_owned(),
        vault_key,
        object_map: loaded.object_map,
        max_version: loaded.max_version,
        pull_cursor: loaded.pull_cursor,
        oversize_skip: HashMap::new(),
    })
}

pub(crate) fn client(state: &ConnectedState) -> Result<Http, SyncErrorKind> {
    Ok(Http::new(&state.base_url)
        .map_err(http_error)?
        .token(state.token.clone()))
}

#[derive(Clone)]
struct LocalFile {
    name: String,
    mtime: i64,
    size: u64,
}

fn local_files(root: &Path) -> Vec<LocalFile> {
    fn walk(root: &Path, dir: &Path, files: &mut Vec<LocalFile>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, files);
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let name = relative.to_string_lossy().replace('\\', "/");
            if !is_syncable_filename(&name) {
                continue;
            }
            if let Ok(metadata) = entry.metadata() {
                files.push(LocalFile {
                    name,
                    mtime: file_mtime_ms(&metadata),
                    size: metadata.len(),
                });
            }
        }
    }
    let mut files = Vec::new();
    walk(root, root, &mut files);
    files.sort_by(|a, b| a.name.cmp(&b.name));
    files
}

fn read_content(root: &Path, name: &str) -> Result<String, String> {
    let path = root.join(name);
    if is_image_filename(name) {
        read_blob_as_base64(&path)
    } else {
        std::fs::read_to_string(path).map_err(|e| e.to_string())
    }
}

fn write_content(
    root: &Path,
    name: &str,
    content: &str,
    pre_write: &PreWrite,
) -> Result<(), String> {
    pre_write(name);
    let path = root.join(name);
    if is_image_filename(name) {
        write_base64_as_blob(&path, content)
    } else {
        write_atomic_text(&path, content)
    }
}

fn encrypt(key: &[u8; 32], name: &str, content: &str) -> Result<Vec<u8>, SyncErrorKind> {
    e2ee::aes_gcm_encrypt(key, &e2ee::pack_note_v2(name, content))
        .map_err(|e| SyncErrorKind::Crypto(e.to_string()))
}

async fn decrypt(http: &Http, key: &[u8; 32], object: &Object) -> Result<Remote, SyncFailure> {
    let blob_key = object.blob_key.as_deref().ok_or_else(|| SyncFailure {
        filename: String::new(),
        kind: FailureKind::Download,
        status_code: None,
    })?;
    let ciphertext = http.blob(blob_key).await.map_err(|error| SyncFailure {
        filename: String::new(),
        kind: FailureKind::Download,
        status_code: error.status,
    })?;
    let plaintext = e2ee::aes_gcm_decrypt(key, &ciphertext).map_err(|_| SyncFailure {
        filename: String::new(),
        kind: FailureKind::Decrypt,
        status_code: None,
    })?;
    let note = e2ee::unpack_note(&plaintext).map_err(|_| SyncFailure {
        filename: String::new(),
        kind: FailureKind::Decrypt,
        status_code: None,
    })?;
    Ok(Remote {
        object: object.clone(),
        name: note.path,
        content: note.content,
    })
}

#[derive(Clone)]
struct Remote {
    object: Object,
    name: String,
    content: String,
}

fn object_state(write: &Write, hash: String, size: u64) -> ObjectState {
    ObjectState {
        object_id: write.object.id.clone(),
        version: write.object.version,
        blob_key: write.object.blob_key.clone().unwrap_or_default(),
        hash: Some(hash),
        mtime_ms: Some(timestamp_ms(&write.object.updated_at)),
        size_bytes: Some(size),
    }
}

fn note_id(name: &str) -> String {
    name.strip_suffix(".md").unwrap_or(name).to_owned()
}

fn conflict_date() -> String {
    let date = time::OffsetDateTime::now_utc().date();
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

struct Upload<'a> {
    name: &'a str,
    content: &'a str,
    hash: String,
    size: u64,
    mtime: i64,
}

async fn create_fresh(
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

struct PushContext<'a> {
    http: &'a Http,
    state: &'a mut ConnectedState,
    root: &'a Path,
    summary: &'a mut SyncSummary,
    pre_write: &'a PreWrite,
}

fn state_from_remote(remote: &Remote) -> ObjectState {
    ObjectState {
        object_id: remote.object.id.clone(),
        version: remote.object.version,
        blob_key: remote.object.blob_key.clone().unwrap_or_default(),
        hash: Some(hash_sha256(&remote.content)),
        mtime_ms: Some(timestamp_ms(&remote.object.updated_at)),
        size_bytes: Some(remote.content.len() as u64),
    }
}

async fn update_existing(
    context: PushContext<'_>,
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

async fn resolve_update_conflict(
    context: PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
    local: &str,
    local_hash: String,
    conflict: Conflict,
    local_was_rename: bool,
) -> Option<(String, ObjectState)> {
    if conflict.current_blob_key.is_none() {
        return create_fresh(
            context.http,
            &mut *context.state,
            Upload {
                name: &file.name,
                content: local,
                hash: local_hash,
                size: file.size,
                mtime: file.mtime,
            },
            &mut *context.summary,
        )
        .await
        .map(|state| (file.name.clone(), state));
    }
    let current = match context
        .http
        .object(&context.state.collection_id, &existing.object_id)
        .await
    {
        Ok(object) => object,
        Err(error) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: error.status,
            });
            return None;
        }
    };
    if current.deleted {
        return create_fresh(
            context.http,
            &mut *context.state,
            Upload {
                name: &file.name,
                content: local,
                hash: local_hash,
                size: file.size,
                mtime: file.mtime,
            },
            &mut *context.summary,
        )
        .await
        .map(|state| (file.name.clone(), state));
    }
    let remote = match decrypt(context.http, &context.state.vault_key, &current).await {
        Ok(remote) => remote,
        Err(mut failure) => {
            failure.filename = file.name.clone();
            context.summary.failures.push(failure);
            return None;
        }
    };
    let remote_name = match classify_incoming_sync_path(&remote.name) {
        IncomingSyncPath::Accept => remote.name.clone(),
        IncomingSyncPath::Sanitize(name) => name,
        _ => file.name.clone(),
    };
    if remote.content == local && !local_was_rename {
        if remote_name != file.name {
            if write_content(context.root, &remote_name, local, context.pre_write).is_err()
                || remove_local(context.root, &file.name, context.pre_write).is_err()
            {
                context.summary.failures.push(SyncFailure {
                    filename: file.name.clone(),
                    kind: FailureKind::Upload,
                    status_code: None,
                });
                return None;
            }
            context.summary.local_writes_applied += 1;
            context.summary.deleted_ids.push(note_id(&file.name));
            context.summary.updated_ids.push(note_id(&remote_name));
            context.summary.peer_updated_ids.push(note_id(&remote_name));
            context.summary.renamed.push(RenamePair {
                from_id: note_id(&file.name),
                to_id: note_id(&remote_name),
            });
        }
        if let Some(modified) = state_from_remote(&remote).mtime_ms {
            (context.pre_write)(&remote_name);
            let _ = set_file_mtime_ms(&context.root.join(&remote_name), modified);
        }
        return Some((remote_name, state_from_remote(&remote)));
    }
    let base = match context.http.blob(&existing.blob_key).await {
        Ok(ciphertext) => e2ee::aes_gcm_decrypt(&context.state.vault_key, &ciphertext)
            .ok()
            .and_then(|plain| e2ee::unpack_note(&plain).ok())
            .map(|note| note.content),
        Err(_) => None,
    };
    let merged = if remote.content == local {
        Some(local.to_owned())
    } else if is_image_filename(&file.name) {
        None
    } else {
        base.and_then(
            |base| match e2ee::three_way_merge_text(&base, &remote.content, local) {
                MergeResult::Clean(merged) => Some(merged),
                MergeResult::Conflict => None,
            },
        )
    };
    if let Some(merged) = merged {
        let target = if local_was_rename {
            file.name.clone()
        } else {
            remote_name.clone()
        };
        let merged_hash = hash_sha256(&merged);
        let ciphertext = encrypt(&context.state.vault_key, &target, &merged).ok()?;
        match context
            .http
            .update_object(
                &context.state.collection_id,
                &existing.object_id,
                conflict.current_version + 1,
                ciphertext,
            )
            .await
        {
            Ok(Mutation::Written(write)) if write.object.deleted => {
                return create_fresh(
                    context.http,
                    &mut *context.state,
                    Upload {
                        name: &target,
                        content: &merged,
                        hash: merged_hash,
                        size: merged.len() as u64,
                        mtime: file.mtime,
                    },
                    &mut *context.summary,
                )
                .await
                .map(|state| (target, state));
            }
            Ok(Mutation::Written(write)) => {
                if write_content(context.root, &target, &merged, context.pre_write).is_err()
                    || (target != file.name
                        && remove_local(context.root, &file.name, context.pre_write).is_err())
                {
                    context.summary.failures.push(SyncFailure {
                        filename: file.name.clone(),
                        kind: FailureKind::Upload,
                        status_code: None,
                    });
                    return None;
                }
                let modified = timestamp_ms(&write.object.updated_at);
                let _ = set_file_mtime_ms(&context.root.join(&target), modified);
                context.state.max_version = context.state.max_version.max(write.collection_version);
                context.summary.uploaded += 1;
                context.summary.local_writes_applied += 1;
                context.summary.updated_ids.push(note_id(&target));
                if target != file.name {
                    context.summary.deleted_ids.push(note_id(&file.name));
                    context.summary.renamed.push(RenamePair {
                        from_id: note_id(&file.name),
                        to_id: note_id(&target),
                    });
                }
                return Some((
                    target,
                    object_state(&write, merged_hash, merged.len() as u64),
                ));
            }
            Err(error) if error.is(413) => {
                context
                    .state
                    .oversize_skip
                    .insert(file.name.clone(), file.mtime);
                context.summary.conflicts += 1;
                return None;
            }
            _ => {}
        }
    }

    let names: HashSet<String> = local_files(context.root)
        .into_iter()
        .map(|f| f.name)
        .collect();
    let copy = conflict_filename(&file.name, &conflict_date(), &names);
    if write_content(context.root, &copy, local, context.pre_write).is_err() {
        context.summary.failures.push(SyncFailure {
            filename: file.name.clone(),
            kind: FailureKind::Upload,
            status_code: None,
        });
        return None;
    }
    let copy_hash = hash_sha256(local);
    if let Some(entry) = create_fresh(
        context.http,
        &mut *context.state,
        Upload {
            name: &copy,
            content: local,
            hash: copy_hash,
            size: local.len() as u64,
            mtime: file.mtime,
        },
        &mut *context.summary,
    )
    .await
    {
        context.state.object_map.insert(copy.clone(), entry);
    }
    if write_content(
        context.root,
        &remote_name,
        &remote.content,
        context.pre_write,
    )
    .is_ok()
        && (remote_name == file.name
            || remove_local(context.root, &file.name, context.pre_write).is_ok())
    {
        let modified = timestamp_ms(&current.updated_at);
        let _ = set_file_mtime_ms(&context.root.join(&remote_name), modified);
        context.summary.local_writes_applied += 2;
        context.summary.conflicts += 1;
        context.summary.updated_ids.push(note_id(&remote_name));
        context.summary.updated_ids.push(note_id(&copy));
        context.summary.peer_updated_ids.push(note_id(&remote_name));
        if remote_name != file.name {
            context.summary.deleted_ids.push(note_id(&file.name));
            context.summary.renamed.push(RenamePair {
                from_id: note_id(&file.name),
                to_id: note_id(&remote_name),
            });
        }
    }
    Some((remote_name, state_from_remote(&remote)))
}

pub(crate) async fn push(
    state: &ConnectedState,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    recover_stale_claims(root, pre_write);
    let http = client(state)?;
    let mut next = state.clone();
    let files = local_files(root);
    let local_names: HashSet<String> = files.iter().map(|f| f.name.clone()).collect();
    let missing: Vec<(String, ObjectState)> = next
        .object_map
        .iter()
        .filter(|(name, _)| !local_names.contains(*name))
        .map(|(name, entry)| (name.clone(), entry.clone()))
        .collect();
    let mut summary = SyncSummary::default();

    let mut hashes = HashMap::new();
    let unmapped: Vec<_> = files
        .iter()
        .filter(|file| !next.object_map.contains_key(&file.name))
        .cloned()
        .collect();
    for file in &unmapped {
        if let Ok(content) = read_content(root, &file.name) {
            hashes.insert(file.name.clone(), hash_sha256(&content));
        }
    }
    let mut claimed_missing = HashSet::new();
    let mut renamed_files = HashSet::new();
    for file in &unmapped {
        let Some(hash) = hashes.get(&file.name) else {
            continue;
        };
        let basename = file.name.rsplit('/').next().unwrap_or(&file.name);
        let candidates: Vec<_> = missing
            .iter()
            .filter(|(old, entry)| {
                !claimed_missing.contains(old)
                    && entry.hash.as_ref() == Some(hash)
                    && old.rsplit('/').next().unwrap_or(old) == basename
            })
            .collect();
        if candidates.len() == 1 {
            let (old, entry) = candidates[0];
            next.object_map.remove(old);
            next.object_map.insert(file.name.clone(), entry.clone());
            claimed_missing.insert(old.clone());
            renamed_files.insert(file.name.clone());
            summary.renamed.push(RenamePair {
                from_id: note_id(old),
                to_id: note_id(&file.name),
            });
        }
    }

    progress(SyncProgress {
        phase: "pushing",
        current: 0,
        total: files.len() + missing.len(),
    });
    let mut completed = 0usize;
    for file in &files {
        if next.oversize_skip.get(&file.name) == Some(&file.mtime) {
            summary.conflicts += 1;
            completed += 1;
            continue;
        }
        let existing = next.object_map.get(&file.name).cloned();
        if !renamed_files.contains(&file.name)
            && existing.as_ref().is_some_and(|entry| {
                entry.mtime_ms == Some(file.mtime) && entry.size_bytes == Some(file.size)
            })
        {
            completed += 1;
            continue;
        }
        let content = match read_content(root, &file.name) {
            Ok(content) => content,
            Err(_) => {
                summary.failures.push(SyncFailure {
                    filename: file.name.clone(),
                    kind: FailureKind::Upload,
                    status_code: None,
                });
                completed += 1;
                continue;
            }
        };
        let hash = hash_sha256(&content);
        if let Some(mut entry) = existing.clone() {
            if !renamed_files.contains(&file.name) && entry.hash.as_ref() == Some(&hash) {
                if let Some(server_mtime) = entry.mtime_ms {
                    if server_mtime != file.mtime {
                        pre_write(&file.name);
                        let _ = set_file_mtime_ms(&root.join(&file.name), server_mtime);
                    }
                }
                entry.size_bytes = Some(file.size);
                next.object_map.insert(file.name.clone(), entry);
                completed += 1;
                continue;
            }
        }
        let result = match existing.as_ref() {
            Some(entry) => {
                update_existing(
                    PushContext {
                        http: &http,
                        state: &mut next,
                        root,
                        summary: &mut summary,
                        pre_write,
                    },
                    file,
                    entry,
                    &content,
                    hash,
                    renamed_files.contains(&file.name),
                )
                .await
            }
            None => create_fresh(
                &http,
                &mut next,
                Upload {
                    name: &file.name,
                    content: &content,
                    hash,
                    size: file.size,
                    mtime: file.mtime,
                },
                &mut summary,
            )
            .await
            .map(|state| (file.name.clone(), state)),
        };
        if let Some((target, entry)) = result {
            if let Some(modified) = entry.mtime_ms {
                pre_write(&target);
                let _ = set_file_mtime_ms(&root.join(&target), modified);
            }
            if target != file.name {
                next.object_map.remove(&file.name);
            }
            next.object_map.insert(target, entry);
        }
        completed += 1;
        progress(SyncProgress {
            phase: "pushing",
            current: completed,
            total: files.len() + missing.len(),
        });
        if completed % 50 == 0
            && store::save(root, &next).is_err()
            && !summary
                .failures
                .iter()
                .any(|f| f.kind == FailureKind::Checkpoint)
        {
            summary.failures.push(SyncFailure {
                filename: String::new(),
                kind: FailureKind::Checkpoint,
                status_code: None,
            });
        }
    }

    let deleted: Vec<_> = missing
        .into_iter()
        .filter(|(name, _)| !claimed_missing.contains(name))
        .filter(|(name, _)| is_syncable_filename(name))
        .filter_map(|(name, _)| {
            next.object_map
                .get(&name)
                .cloned()
                .map(|entry| (name, entry))
        })
        .collect();
    for (name, entry) in deleted {
        match http
            .delete_object(&next.collection_id, &entry.object_id, entry.version)
            .await
        {
            Ok(Mutation::Written(write)) => {
                next.max_version = next.max_version.max(write.collection_version);
                next.object_map.remove(&name);
                summary.deleted += 1;
                summary.deleted_ids.push(note_id(&name));
            }
            Ok(Mutation::Conflict(_)) => {
                let current = http
                    .object(&next.collection_id, &entry.object_id)
                    .await
                    .map_err(collection_error)?;
                if let Ok(remote) = decrypt(&http, &next.vault_key, &current).await {
                    let target = match classify_incoming_sync_path(&remote.name) {
                        IncomingSyncPath::Accept => remote.name.clone(),
                        IncomingSyncPath::Sanitize(name) => name,
                        _ => name.clone(),
                    };
                    write_content(root, &target, &remote.content, pre_write)
                        .map_err(SyncErrorKind::Io)?;
                    let remote_state = state_from_remote(&remote);
                    if let Some(mtime) = remote_state.mtime_ms {
                        let _ = set_file_mtime_ms(&root.join(&target), mtime);
                    }
                    next.object_map.remove(&name);
                    next.object_map.insert(target.clone(), remote_state);
                    summary.downloaded += 1;
                    summary.conflicts += 1;
                    summary.local_writes_applied += 1;
                    summary.peer_updated_ids.push(note_id(&target));
                }
            }
            Err(error) => summary.failures.push(SyncFailure {
                filename: name,
                kind: FailureKind::Delete,
                status_code: error.status,
            }),
        }
    }
    for rename in derive_renames(&state.object_map, &next.object_map) {
        if !summary
            .renamed
            .iter()
            .any(|existing| existing.from_id == rename.from_id && existing.to_id == rename.to_id)
        {
            summary.renamed.push(rename);
        }
    }
    store::save(root, &next).map_err(SyncErrorKind::Io)?;
    Ok((summary, next))
}

fn remove_local(root: &Path, name: &str, pre_write: &PreWrite) -> Result<bool, String> {
    pre_write(name);
    match std::fs::remove_file(root.join(name)) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

const CLAIM_PREFIX: &str = ".sf-tomb-";
const CLAIM_SIDECAR_SUFFIX: &str = ".path";

fn claim_paths(
    root: &Path,
    name: &str,
    object_id: &str,
) -> (std::path::PathBuf, std::path::PathBuf) {
    let digest = hash_sha256(&format!("{object_id}\0{name}"));
    let claim = root.join(format!("{CLAIM_PREFIX}{digest}"));
    let sidecar = root.join(format!("{CLAIM_PREFIX}{digest}{CLAIM_SIDECAR_SUFFIX}"));
    (claim, sidecar)
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn recover_stale_claims(root: &Path, pre_write: &PreWrite) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(CLAIM_PREFIX))
        .collect();

    for name in names
        .iter()
        .filter(|name| !name.ends_with(CLAIM_SIDECAR_SUFFIX))
    {
        let claim = root.join(name);
        let sidecar = root.join(format!("{name}{CLAIM_SIDECAR_SUFFIX}"));
        let Ok(original) = std::fs::read_to_string(&sidecar) else {
            continue;
        };
        if !matches!(
            classify_incoming_sync_path(&original),
            IncomingSyncPath::Accept
        ) {
            continue;
        }
        let destination = root.join(&original);
        if destination.exists() {
            let _ = remove_if_present(&claim);
            let _ = remove_if_present(&sidecar);
            continue;
        }
        if let Some(parent) = destination.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        pre_write(&original);
        if std::fs::rename(&claim, &destination).is_ok() {
            let _ = remove_if_present(&sidecar);
        }
    }

    for name in names
        .iter()
        .filter(|name| name.ends_with(CLAIM_SIDECAR_SUFFIX))
    {
        let claim_name = name.trim_end_matches(CLAIM_SIDECAR_SUFFIX);
        if !root.join(claim_name).exists() {
            let _ = remove_if_present(&root.join(name));
        }
    }
}

fn claim_local(
    root: &Path,
    name: &str,
    object_id: &str,
    pre_write: &PreWrite,
) -> Result<Option<(std::path::PathBuf, std::path::PathBuf)>, String> {
    let (claim, sidecar) = claim_paths(root, name, object_id);
    write_atomic_text(&sidecar, name)?;
    pre_write(name);
    match std::fs::rename(root.join(name), &claim) {
        Ok(()) => Ok(Some((claim, sidecar))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let _ = remove_if_present(&sidecar);
            Ok(None)
        }
        Err(error) => {
            let _ = remove_if_present(&sidecar);
            Err(error.to_string())
        }
    }
}

fn restore_claim(claim: &Path, sidecar: &Path, destination: &Path) {
    if !destination.exists() {
        if let Some(parent) = destination.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::rename(claim, destination).is_ok() {
            let _ = remove_if_present(sidecar);
        }
    }
}

fn claim_content(claim: &Path, original_name: &str) -> Result<String, String> {
    if is_image_filename(original_name) {
        read_blob_as_base64(claim)
    } else {
        std::fs::read_to_string(claim).map_err(|error| error.to_string())
    }
}

fn park_local(
    root: &Path,
    name: &str,
    object_id: &str,
    pre_write: &PreWrite,
) -> Result<String, String> {
    let mut target = collision_conflict_filename(name, object_id);
    if root.join(&target).exists() {
        let names = local_files(root).into_iter().map(|f| f.name).collect();
        target = conflict_filename(name, &conflict_date(), &names);
    }
    pre_write(name);
    pre_write(&target);
    if let Some(parent) = root.join(&target).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(root.join(name), root.join(&target)).map_err(|e| e.to_string())?;
    Ok(target)
}

fn mapped_name(state: &ConnectedState, object_id: &str) -> Option<String> {
    state
        .object_map
        .iter()
        .find(|(_, entry)| entry.object_id == object_id)
        .map(|(name, _)| name.clone())
}

fn object_is_current(entry: &ObjectState, object: &Object) -> bool {
    entry.version == object.version
        && entry.blob_key == object.blob_key.as_deref().unwrap_or_default()
}

fn content_hash(root: &Path, name: &str) -> Option<String> {
    read_content(root, name)
        .ok()
        .map(|content| hash_sha256(&content))
}

fn place_collision(
    state: &mut ConnectedState,
    root: &Path,
    remote: &Remote,
    requested: &str,
    pre_write: &PreWrite,
    summary: &mut SyncSummary,
) -> Result<Option<String>, String> {
    let key = collision_key(requested);
    let rivals: Vec<_> = state
        .object_map
        .iter()
        .filter(|(name, entry)| entry.object_id != remote.object.id && collision_key(name) == key)
        .map(|(name, entry)| (name.clone(), entry.clone()))
        .collect();
    if rivals.is_empty() {
        return Ok(Some(requested.to_owned()));
    }
    let remote_hash = hash_sha256(&remote.content);
    let winner = rivals
        .iter()
        .map(|(_, entry)| entry.object_id.as_str())
        .chain(std::iter::once(remote.object.id.as_str()))
        .min()
        .unwrap_or(remote.object.id.as_str());
    if winner != remote.object.id {
        if rivals.iter().any(|(name, entry)| {
            entry.hash.as_ref() == Some(&remote_hash) && root.join(name).exists()
        }) {
            return Ok(None);
        }
        return Ok(Some(collision_conflict_filename(
            requested,
            &remote.object.id,
        )));
    }
    for (name, entry) in rivals {
        if entry.hash.as_ref() == Some(&remote_hash) {
            state.object_map.remove(&name);
            continue;
        }
        if root.join(&name).exists() {
            let target = collision_conflict_filename(requested, &entry.object_id);
            pre_write(&name);
            pre_write(&target);
            if let Some(parent) = root.join(&target).parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::rename(root.join(&name), root.join(&target)).map_err(|e| e.to_string())?;
            state.object_map.remove(&name);
            state.object_map.insert(target.clone(), entry);
            summary.local_writes_applied += 1;
            summary.deleted_ids.push(note_id(&name));
            summary.updated_ids.push(note_id(&target));
        }
    }
    Ok(Some(requested.to_owned()))
}

fn apply_tombstone(
    state: &mut ConnectedState,
    root: &Path,
    object: &Object,
    ancestry: &HashMap<String, Ancestry>,
    pre_write: &PreWrite,
    summary: &mut SyncSummary,
) -> Result<(), String> {
    let mapped = mapped_name(state, &object.id);
    let ancestral = ancestry
        .iter()
        .find(|(_, entry)| entry.object_id == object.id)
        .map(|(name, entry)| (name.clone(), entry.clone()));
    let Some((name, expected_hash)) = mapped
        .and_then(|name| {
            state
                .object_map
                .get(&name)
                .and_then(|entry| entry.hash.clone())
                .map(|hash| (name, hash))
        })
        .or_else(|| ancestral.map(|(name, entry)| (name, entry.hash)))
    else {
        return Ok(());
    };
    let Some((claim, sidecar)) = claim_local(root, &name, &object.id, pre_write)? else {
        state.object_map.remove(&name);
        return Ok(());
    };
    let current = match claim_content(&claim, &name) {
        Ok(content) => content,
        Err(error) => {
            restore_claim(&claim, &sidecar, &root.join(&name));
            return Err(error);
        }
    };
    if hash_sha256(&current) == expected_hash {
        if let Err(error) = remove_if_present(&claim) {
            restore_claim(&claim, &sidecar, &root.join(&name));
            return Err(error);
        }
        summary.local_writes_applied += 1;
    } else {
        let names = local_files(root)
            .into_iter()
            .map(|file| file.name)
            .collect();
        let mut copy = collision_conflict_filename(&name, &object.id);
        if root.join(&copy).exists() {
            copy = conflict_filename(&name, &conflict_date(), &names);
        }
        pre_write(&copy);
        if let Some(parent) = root.join(&copy).parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        if let Err(error) = std::fs::rename(&claim, root.join(&copy)) {
            restore_claim(&claim, &sidecar, &root.join(&name));
            return Err(error.to_string());
        }
        summary.conflicts += 1;
        summary.local_writes_applied += 1;
        summary.updated_ids.push(note_id(&copy));
        summary.peer_updated_ids.push(note_id(&copy));
    }
    remove_if_present(&sidecar)?;
    state.object_map.remove(&name);
    summary.deleted += 1;
    summary.deleted_ids.push(note_id(&name));
    summary.peer_deleted_ids.push(note_id(&name));
    Ok(())
}

fn ancestry_for<'a>(
    ancestry: &'a HashMap<String, Ancestry>,
    object_id: &str,
) -> Option<(&'a str, &'a Ancestry)> {
    ancestry
        .iter()
        .find(|(_, entry)| entry.object_id == object_id)
        .map(|(name, entry)| (name.as_str(), entry))
}

fn apply_remote(
    state: &mut ConnectedState,
    root: &Path,
    remote: &Remote,
    ancestry: &HashMap<String, Ancestry>,
    bootstrap: bool,
    pre_write: &PreWrite,
    summary: &mut SyncSummary,
) -> Result<(), String> {
    let requested = match classify_incoming_sync_path(&remote.name) {
        IncomingSyncPath::Ignore => return Ok(()),
        IncomingSyncPath::Accept => remote.name.clone(),
        IncomingSyncPath::Sanitize(name) => name,
        IncomingSyncPath::Reject(_) => {
            summary.failures.push(SyncFailure {
                filename: remote.name.clone(),
                kind: FailureKind::Rejected,
                status_code: None,
            });
            return Ok(());
        }
    };
    let remote_hash = hash_sha256(&remote.content);
    let mut replace_unmapped_target = false;

    if bootstrap {
        if let Some((old_name, ancestor)) = ancestry_for(ancestry, &remote.object.id) {
            if root.join(old_name).exists() {
                let local_hash = content_hash(root, old_name);
                if local_hash.as_deref() == Some(ancestor.hash.as_str()) {
                    replace_unmapped_target = true;
                    if old_name != requested {
                        let _ = remove_local(root, old_name, pre_write)?;
                        summary.deleted_ids.push(note_id(old_name));
                        summary.peer_deleted_ids.push(note_id(old_name));
                    }
                } else if remote_hash == ancestor.hash {
                    let mut entry = state_from_remote(remote);
                    entry.hash = Some(ancestor.hash.clone());
                    entry.mtime_ms = None;
                    entry.size_bytes = None;
                    state.object_map.insert(old_name.to_owned(), entry);
                    return Ok(());
                } else {
                    let copy = park_local(root, old_name, &remote.object.id, pre_write)?;
                    summary.conflicts += 1;
                    summary.local_writes_applied += 1;
                    summary.updated_ids.push(note_id(&copy));
                    summary.peer_updated_ids.push(note_id(&copy));
                }
            }
        }
    }

    let Some(target) = place_collision(state, root, remote, &requested, pre_write, summary)? else {
        return Ok(());
    };

    if let Some(old_name) = mapped_name(state, &remote.object.id) {
        if old_name != target {
            if root.join(&old_name).exists() {
                let expected = state
                    .object_map
                    .get(&old_name)
                    .and_then(|entry| entry.hash.as_deref());
                let current = content_hash(root, &old_name);
                if current.as_deref() == expected {
                    let _ = remove_local(root, &old_name, pre_write)?;
                } else {
                    let copy = park_local(root, &old_name, &remote.object.id, pre_write)?;
                    summary.conflicts += 1;
                    summary.updated_ids.push(note_id(&copy));
                }
            }
            state.object_map.remove(&old_name);
            summary.deleted_ids.push(note_id(&old_name));
            summary.peer_deleted_ids.push(note_id(&old_name));
            summary.renamed.push(RenamePair {
                from_id: note_id(&old_name),
                to_id: note_id(&target),
            });
        }
    }

    let already = state.object_map.get(&target).is_some_and(|entry| {
        entry.object_id == remote.object.id
            && entry.version == remote.object.version
            && entry.blob_key == remote.object.blob_key.as_deref().unwrap_or_default()
    });
    if already {
        return Ok(());
    }

    if root.join(&target).exists()
        && !state.object_map.contains_key(&target)
        && !replace_unmapped_target
    {
        let local_hash = content_hash(root, &target);
        if local_hash.as_deref() != Some(remote_hash.as_str()) {
            let copy = park_local(root, &target, &remote.object.id, pre_write)?;
            summary.conflicts += 1;
            summary.local_writes_applied += 1;
            summary.updated_ids.push(note_id(&copy));
            summary.peer_updated_ids.push(note_id(&copy));
        }
    }

    let needs_content_write = content_hash(root, &target).as_deref() != Some(remote_hash.as_str());
    if needs_content_write {
        write_content(root, &target, &remote.content, pre_write)?;
        summary.local_writes_applied += 1;
    }
    let modified = timestamp_ms(&remote.object.updated_at);
    if modified > 0 {
        pre_write(&target);
        let _ = set_file_mtime_ms(&root.join(&target), modified);
    }
    state
        .object_map
        .insert(target.clone(), state_from_remote(remote));
    summary.downloaded += 1;
    summary.updated_ids.push(note_id(&target));
    summary.peer_updated_ids.push(note_id(&target));
    Ok(())
}

pub(crate) async fn pull(
    state: &ConnectedState,
    root: &Path,
    since: u64,
    progress: &Progress,
    pre_write: &PreWrite,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    recover_stale_claims(root, pre_write);
    let http = client(state)?;
    let objects = http
        .objects(&state.collection_id, since)
        .await
        .map_err(collection_error)?;
    let ancestry = store::load_ancestry(root);
    let bootstrap = state.object_map.is_empty() && since == 0;
    let mut next = state.clone();
    let mut summary = SyncSummary::default();
    let mut highest = since;
    let mut lowest_failed = None::<u64>;
    progress(SyncProgress {
        phase: "pulling",
        current: 0,
        total: objects.len(),
    });
    for (index, object) in objects.iter().enumerate() {
        highest = highest.max(object.change_seq);
        if object.deleted {
            if apply_tombstone(&mut next, root, object, &ancestry, pre_write, &mut summary).is_err()
            {
                lowest_failed =
                    Some(lowest_failed.map_or(object.change_seq, |n| n.min(object.change_seq)));
                summary.failures.push(SyncFailure {
                    filename: String::new(),
                    kind: FailureKind::Download,
                    status_code: None,
                });
            }
        } else if let Some(existing_name) = mapped_name(&next, &object.id) {
            let existing = &next.object_map[&existing_name];
            if object_is_current(existing, object) {
                progress(SyncProgress {
                    phase: "pulling",
                    current: index + 1,
                    total: objects.len(),
                });
                continue;
            }
            match decrypt(&http, &next.vault_key, object).await {
                Ok(remote) => {
                    if apply_remote(
                        &mut next,
                        root,
                        &remote,
                        &ancestry,
                        bootstrap,
                        pre_write,
                        &mut summary,
                    )
                    .is_err()
                    {
                        lowest_failed = Some(
                            lowest_failed.map_or(object.change_seq, |n| n.min(object.change_seq)),
                        );
                        summary.failures.push(SyncFailure {
                            filename: remote.name,
                            kind: FailureKind::Download,
                            status_code: None,
                        });
                    }
                }
                Err(mut failure) => {
                    failure.filename = existing_name;
                    if failure.kind != FailureKind::Rejected {
                        lowest_failed = Some(
                            lowest_failed.map_or(object.change_seq, |n| n.min(object.change_seq)),
                        );
                    }
                    summary.failures.push(failure);
                }
            }
        } else {
            match decrypt(&http, &next.vault_key, object).await {
                Ok(remote) => {
                    if apply_remote(
                        &mut next,
                        root,
                        &remote,
                        &ancestry,
                        bootstrap,
                        pre_write,
                        &mut summary,
                    )
                    .is_err()
                    {
                        lowest_failed = Some(
                            lowest_failed.map_or(object.change_seq, |n| n.min(object.change_seq)),
                        );
                        summary.failures.push(SyncFailure {
                            filename: remote.name,
                            kind: FailureKind::Download,
                            status_code: None,
                        });
                    }
                }
                Err(failure) => {
                    lowest_failed =
                        Some(lowest_failed.map_or(object.change_seq, |n| n.min(object.change_seq)));
                    summary.failures.push(failure);
                }
            }
        }
        progress(SyncProgress {
            phase: "pulling",
            current: index + 1,
            total: objects.len(),
        });
    }
    let cursor = cap_cursor(highest, lowest_failed);
    for rename in derive_renames(&state.object_map, &next.object_map) {
        if !summary
            .renamed
            .iter()
            .any(|existing| existing.from_id == rename.from_id && existing.to_id == rename.to_id)
        {
            summary.renamed.push(rename);
        }
    }
    next.max_version = cursor;
    next.pull_cursor = cursor;
    store::save(root, &next).map_err(SyncErrorKind::Io)?;
    if lowest_failed.is_none() {
        store::clear_ancestry(root);
    }
    Ok((summary, next))
}

fn cap_cursor(highest: u64, lowest_failed: Option<u64>) -> u64 {
    lowest_failed
        .map(|failed| highest.min(failed.saturating_sub(1)))
        .unwrap_or(highest)
}

fn append_unique(target: &mut Vec<String>, source: Vec<String>) {
    for item in source {
        if !target.contains(&item) {
            target.push(item);
        }
    }
}

fn derive_renames(
    before: &HashMap<String, ObjectState>,
    after: &HashMap<String, ObjectState>,
) -> Vec<RenamePair> {
    let removed: Vec<_> = before
        .iter()
        .filter(|(name, _)| !after.contains_key(*name))
        .collect();
    let added: Vec<_> = after
        .iter()
        .filter(|(name, _)| !before.contains_key(*name))
        .collect();
    let mut renames = Vec::new();
    for (old_name, old) in &removed {
        let Some(hash) = old.hash.as_ref() else {
            continue;
        };
        let candidates: Vec<_> = added
            .iter()
            .filter(|(_, entry)| entry.hash.as_ref() == Some(hash))
            .collect();
        let removed_with_hash = removed
            .iter()
            .filter(|(_, entry)| entry.hash.as_ref() == Some(hash))
            .count();
        if candidates.len() == 1 && removed_with_hash == 1 {
            renames.push(RenamePair {
                from_id: note_id(old_name),
                to_id: note_id(candidates[0].0),
            });
        }
    }
    renames
}

fn combine(mut push: SyncSummary, pull: SyncSummary) -> SyncSummary {
    push.uploaded += pull.uploaded;
    push.downloaded += pull.downloaded;
    push.deleted += pull.deleted;
    push.conflicts += pull.conflicts;
    push.local_writes_applied += pull.local_writes_applied;
    push.failures.extend(pull.failures);
    append_unique(&mut push.updated_ids, pull.updated_ids);
    append_unique(&mut push.deleted_ids, pull.deleted_ids);
    append_unique(&mut push.peer_updated_ids, pull.peer_updated_ids);
    append_unique(&mut push.peer_deleted_ids, pull.peer_deleted_ids);
    for rename in pull.renamed {
        if !push
            .renamed
            .iter()
            .any(|current| current.from_id == rename.from_id && current.to_id == rename.to_id)
        {
            push.renamed.push(rename);
        }
    }
    let renamed_from: HashSet<_> = push
        .renamed
        .iter()
        .map(|rename| rename.from_id.as_str())
        .collect();
    let renamed_to: HashSet<_> = push
        .renamed
        .iter()
        .map(|rename| rename.to_id.as_str())
        .collect();
    push.updated_ids
        .retain(|id| !renamed_to.contains(id.as_str()));
    push.peer_updated_ids
        .retain(|id| !renamed_to.contains(id.as_str()));
    push.deleted_ids
        .retain(|id| !renamed_from.contains(id.as_str()) && !renamed_to.contains(id.as_str()));
    push.peer_deleted_ids
        .retain(|id| !renamed_from.contains(id.as_str()) && !renamed_to.contains(id.as_str()));
    push
}

pub(crate) async fn cycle(
    state: &ConnectedState,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    let (bootstrap, ready) = if state.object_map.is_empty() && state.max_version == 0 {
        pull(state, root, 0, progress, pre_write).await?
    } else {
        (SyncSummary::default(), state.clone())
    };
    let pull_since = ready.pull_cursor;
    let (pushed, after_push) = push(&ready, root, progress, pre_write).await?;
    let (pulled, after_pull) = pull(&after_push, root, pull_since, progress, pre_write).await?;
    Ok((combine(bootstrap, combine(pushed, pulled)), after_pull))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempRoot(std::path::PathBuf);

    impl TempRoot {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "futo-sync-engine-test-{}-{n}",
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

    fn no_pre(_: &str) {}

    fn no_progress(_: SyncProgress) {}

    fn entry(object_id: &str, hash: Option<&str>) -> ObjectState {
        ObjectState {
            object_id: object_id.into(),
            version: 1,
            blob_key: format!("blob-{object_id}"),
            hash: hash.map(str::to_owned),
            mtime_ms: Some(1_700_000_000_000),
            size_bytes: Some(4),
        }
    }

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

    fn object(id: &str, change_seq: u64, deleted: bool) -> Object {
        Object {
            id: id.into(),
            version: 1,
            change_seq,
            deleted,
            blob_key: (!deleted).then(|| format!("blob-{id}")),
            updated_at: "2026-06-05T12:34:56.789Z".into(),
        }
    }

    fn remote(id: &str, name: &str, content: &str) -> Remote {
        Remote {
            object: object(id, 1, false),
            name: name.into(),
            content: content.into(),
        }
    }

    fn failure(kind: FailureKind, status_code: Option<u16>) -> SyncFailure {
        SyncFailure {
            filename: "note.md".into(),
            kind,
            status_code,
        }
    }

    #[test]
    fn failure_messages_are_honest_and_deterministic() {
        assert_eq!(SyncSummary::default().failure_message(), None);

        let summary = SyncSummary {
            failures: vec![
                failure(FailureKind::Upload, Some(500)),
                failure(FailureKind::Delete, Some(409)),
                failure(FailureKind::Upload, Some(409)),
                failure(FailureKind::Download, None),
                failure(FailureKind::Decrypt, None),
                failure(FailureKind::Checkpoint, None),
            ],
            ..Default::default()
        };
        assert_eq!(
            summary.failure_message().as_deref(),
            Some(
                "3 changes couldn't reach the server (HTTP 409); 1 note couldn't be downloaded (will retry); 1 note couldn't be decrypted; sync state couldn't be saved locally"
            )
        );

        let tie = SyncSummary {
            failures: vec![
                failure(FailureKind::Upload, Some(503)),
                failure(FailureKind::Delete, Some(500)),
            ],
            ..Default::default()
        };
        assert!(tie.failure_message().unwrap().contains("HTTP 503"));
    }

    #[test]
    fn failure_kind_wire_strings_are_stable() {
        assert_eq!(FailureKind::Upload.as_str(), "upload");
        assert_eq!(FailureKind::Delete.as_str(), "delete");
        assert_eq!(FailureKind::Checkpoint.as_str(), "checkpoint");
        assert_eq!(FailureKind::Download.as_str(), "download");
        assert_eq!(FailureKind::Decrypt.as_str(), "decrypt");
        assert_eq!(FailureKind::Rejected.as_str(), "rejected");
    }

    #[test]
    fn combined_summary_keeps_counts_failures_and_unique_ids() {
        let push = SyncSummary {
            uploaded: 2,
            downloaded: 1,
            local_writes_applied: 1,
            failures: vec![failure(FailureKind::Upload, Some(500))],
            updated_ids: vec!["same".into()],
            ..Default::default()
        };
        let pull = SyncSummary {
            uploaded: 1,
            downloaded: 3,
            local_writes_applied: 4,
            failures: vec![failure(FailureKind::Download, None)],
            updated_ids: vec!["same".into(), "new".into()],
            ..Default::default()
        };
        let combined = combine(push, pull);
        assert_eq!(combined.uploaded, 3);
        assert_eq!(combined.downloaded, 4);
        assert_eq!(combined.local_writes_applied, 5);
        assert_eq!(combined.failures.len(), 2);
        assert_eq!(combined.updated_ids, ["same", "new"]);
    }

    #[test]
    fn rename_replaces_ghost_create_and_delete_ids() {
        let push = SyncSummary {
            deleted_ids: vec!["old".into()],
            peer_deleted_ids: vec!["old".into()],
            renamed: vec![RenamePair {
                from_id: "old".into(),
                to_id: "new".into(),
            }],
            ..Default::default()
        };
        let pull = SyncSummary {
            updated_ids: vec!["new".into()],
            peer_updated_ids: vec!["new".into()],
            ..Default::default()
        };
        let combined = combine(push, pull);
        assert!(combined.deleted_ids.is_empty());
        assert!(combined.peer_deleted_ids.is_empty());
        assert!(combined.updated_ids.is_empty());
        assert!(combined.peer_updated_ids.is_empty());
        assert_eq!(combined.renamed.len(), 1);
    }

    #[test]
    fn rename_inference_requires_a_unique_hash_on_both_sides() {
        let before = HashMap::from([("old.md".into(), entry("o1", Some("hash")))]);
        let after = HashMap::from([("new.md".into(), entry("o1", Some("hash")))]);
        let renamed = derive_renames(&before, &after);
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].from_id, "old");
        assert_eq!(renamed[0].to_id, "new");

        let ambiguous_before = HashMap::from([
            ("a.md".into(), entry("o1", Some("same"))),
            ("b.md".into(), entry("o2", Some("same"))),
        ]);
        let ambiguous_after = HashMap::from([
            ("c.md".into(), entry("o1", Some("same"))),
            ("d.md".into(), entry("o2", Some("same"))),
        ]);
        assert!(derive_renames(&ambiguous_before, &ambiguous_after).is_empty());
    }

    #[test]
    fn cursor_never_advances_past_the_first_failed_change() {
        assert_eq!(cap_cursor(20, None), 20);
        assert_eq!(cap_cursor(20, Some(7)), 6);
        assert_eq!(cap_cursor(5, Some(7)), 5);
        assert_eq!(cap_cursor(20, Some(0)), 0);
    }

    #[test]
    fn same_version_is_current_only_when_the_blob_key_also_matches() {
        let entry = entry("o1", Some("hash"));
        let mut remote = object("o1", 1, false);
        assert!(object_is_current(&entry, &remote));
        remote.blob_key = Some("rotated".into());
        assert!(!object_is_current(&entry, &remote));
    }

    #[test]
    fn identifiers_and_conflict_dates_keep_the_external_shape() {
        assert_eq!(note_id("folder/note.md"), "folder/note");
        assert_eq!(note_id("image.png"), "image.png");
        let date = conflict_date();
        assert_eq!(date.len(), 10);
        assert_eq!(&date[4..5], "-");
        assert_eq!(&date[7..8], "-");
    }

    #[test]
    fn local_scan_ignores_hidden_and_legacy_files_but_keeps_images() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("note.md"), "note").unwrap();
        std::fs::write(root.path().join("image.png"), [1, 2, 3]).unwrap();
        std::fs::write(root.path().join("legacy.tiff"), [1, 2, 3]).unwrap();
        std::fs::write(root.path().join(".hidden.md"), "hidden").unwrap();
        std::fs::create_dir(root.path().join(".hidden")).unwrap();
        std::fs::write(root.path().join(".hidden/note.md"), "hidden").unwrap();
        let names: Vec<_> = local_files(root.path())
            .into_iter()
            .map(|file| file.name)
            .collect();
        assert_eq!(names, ["image.png", "note.md"]);
    }

    #[test]
    fn incoming_names_are_ignored_healed_or_rejected_before_writing() {
        let root = TempRoot::new();
        let mut state = connected();
        let mut summary = SyncSummary::default();
        let ancestry = HashMap::new();

        apply_remote(
            &mut state,
            root.path(),
            &remote("legacy", "scan.tiff", "AAAA"),
            &ancestry,
            false,
            &no_pre,
            &mut summary,
        )
        .unwrap();
        assert!(!root.path().join("scan.tiff").exists());

        apply_remote(
            &mut state,
            root.path(),
            &remote("healed", "CON.md", "device"),
            &ancestry,
            false,
            &no_pre,
            &mut summary,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("CON_.md")).unwrap(),
            "device"
        );
        assert!(state.object_map.contains_key("CON_.md"));

        apply_remote(
            &mut state,
            root.path(),
            &remote("unsafe", "../escape.md", "evil"),
            &ancestry,
            false,
            &no_pre,
            &mut summary,
        )
        .unwrap();
        assert!(!root.path().join("escape.md").exists());
        assert_eq!(summary.failures.len(), 1);
        assert_eq!(summary.failures[0].kind, FailureKind::Rejected);
        assert!(!summary.failure_message().unwrap().contains("will retry"));
    }

    #[test]
    fn colliding_remote_notes_both_survive_but_identical_content_deduplicates() {
        let root = TempRoot::new();
        let ancestry = HashMap::new();
        let mut state = connected();
        let mut summary = SyncSummary::default();

        apply_remote(
            &mut state,
            root.path(),
            &remote("a-object", "note.md", "first"),
            &ancestry,
            false,
            &no_pre,
            &mut summary,
        )
        .unwrap();
        apply_remote(
            &mut state,
            root.path(),
            &remote("b-object", "note.md", "second"),
            &ancestry,
            false,
            &no_pre,
            &mut summary,
        )
        .unwrap();
        let files = local_files(root.path());
        assert_eq!(files.len(), 2);
        let contents: HashSet<_> = files
            .iter()
            .map(|file| read_content(root.path(), &file.name).unwrap())
            .collect();
        assert_eq!(contents, HashSet::from(["first".into(), "second".into()]));

        let before = local_files(root.path()).len();
        apply_remote(
            &mut state,
            root.path(),
            &remote("c-object", "note.md", "first"),
            &ancestry,
            false,
            &no_pre,
            &mut summary,
        )
        .unwrap();
        assert_eq!(local_files(root.path()).len(), before);
    }

    #[test]
    fn tombstone_deletes_unchanged_content_and_parks_a_divergent_edit() {
        let root = TempRoot::new();
        let ancestry = HashMap::new();

        std::fs::write(root.path().join("same.md"), "original").unwrap();
        let mut same_state = connected();
        same_state.object_map.insert(
            "same.md".into(),
            entry("same-object", Some(&hash_sha256("original"))),
        );
        let mut same_summary = SyncSummary::default();
        apply_tombstone(
            &mut same_state,
            root.path(),
            &object("same-object", 5, true),
            &ancestry,
            &no_pre,
            &mut same_summary,
        )
        .unwrap();
        assert!(!root.path().join("same.md").exists());
        assert_eq!(same_summary.deleted, 1);

        std::fs::write(root.path().join("edited.md"), "local edit").unwrap();
        let mut edited_state = connected();
        edited_state.object_map.insert(
            "edited.md".into(),
            entry("edited-object", Some(&hash_sha256("old base"))),
        );
        let mut edited_summary = SyncSummary::default();
        apply_tombstone(
            &mut edited_state,
            root.path(),
            &object("edited-object", 6, true),
            &ancestry,
            &no_pre,
            &mut edited_summary,
        )
        .unwrap();
        assert!(!root.path().join("edited.md").exists());
        let copy = collision_conflict_filename("edited.md", "edited-object");
        assert_eq!(
            std::fs::read_to_string(root.path().join(copy)).unwrap(),
            "local edit"
        );
        assert_eq!(edited_summary.conflicts, 1);
    }

    #[test]
    fn tombstone_without_identity_or_ancestry_cannot_delete_an_unrelated_file() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("keep.md"), "keep").unwrap();
        let mut state = connected();
        let mut summary = SyncSummary::default();
        apply_tombstone(
            &mut state,
            root.path(),
            &object("unknown", 3, true),
            &HashMap::new(),
            &no_pre,
            &mut summary,
        )
        .unwrap();
        assert!(root.path().join("keep.md").exists());
        assert_eq!(summary.deleted, 0);
    }

    #[test]
    fn stale_tombstone_claim_is_restored_after_a_crash() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("note.md"), "recover me").unwrap();
        let (claim, sidecar) = claim_local(root.path(), "note.md", "o1", &no_pre)
            .unwrap()
            .unwrap();
        assert!(claim.exists());
        assert!(sidecar.exists());
        assert!(!root.path().join("note.md").exists());

        recover_stale_claims(root.path(), &no_pre);
        assert_eq!(
            std::fs::read_to_string(root.path().join("note.md")).unwrap(),
            "recover me"
        );
        assert!(!claim.exists());
        assert!(!sidecar.exists());
    }

    #[test]
    fn recreated_original_wins_over_a_stale_claim() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("note.md"), "old").unwrap();
        let (claim, sidecar) = claim_local(root.path(), "note.md", "o1", &no_pre)
            .unwrap()
            .unwrap();
        std::fs::write(root.path().join("note.md"), "new").unwrap();

        recover_stale_claims(root.path(), &no_pre);
        assert_eq!(
            std::fs::read_to_string(root.path().join("note.md")).unwrap(),
            "new"
        );
        assert!(!claim.exists());
        assert!(!sidecar.exists());
    }

    #[test]
    fn failed_stale_claim_restore_keeps_the_recoverable_bytes() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("folder"), "blocks directory creation").unwrap();
        let (claim, sidecar) = claim_paths(root.path(), "folder/note.md", "o1");
        std::fs::write(&claim, "recover me later").unwrap();
        std::fs::write(&sidecar, "folder/note.md").unwrap();

        recover_stale_claims(root.path(), &no_pre);

        assert_eq!(std::fs::read_to_string(&claim).unwrap(), "recover me later");
        assert!(sidecar.exists());
        assert!(!root.path().join("folder/note.md").exists());
    }

    #[test]
    fn stale_claim_sweep_cleans_orphan_sidecars_without_guessing_claim_paths() {
        let root = TempRoot::new();
        let (claim, sidecar) = claim_paths(root.path(), "note.md", "o1");
        std::fs::write(&sidecar, "note.md").unwrap();
        recover_stale_claims(root.path(), &no_pre);
        assert!(!sidecar.exists());

        std::fs::write(&claim, "unknown origin").unwrap();
        recover_stale_claims(root.path(), &no_pre);
        assert_eq!(std::fs::read_to_string(&claim).unwrap(), "unknown origin");
    }

    #[test]
    fn tombstone_io_error_is_not_reported_as_convergence() {
        let root = TempRoot::new();
        std::fs::create_dir(root.path().join("note.md")).unwrap();
        let mut state = connected();
        state.object_map.insert(
            "note.md".into(),
            entry("o1", Some(&hash_sha256("expected file content"))),
        );
        let mut summary = SyncSummary::default();

        assert!(apply_tombstone(
            &mut state,
            root.path(),
            &object("o1", 4, true),
            &HashMap::new(),
            &no_pre,
            &mut summary,
        )
        .is_err());
        assert!(root.path().join("note.md").is_dir());
        assert!(state.object_map.contains_key("note.md"));
        assert_eq!(summary.deleted, 0);
    }

    #[test]
    fn claim_names_are_bounded_even_for_deep_long_paths() {
        let root = TempRoot::new();
        let name = format!("{}/{}.md", "deep/".repeat(40), "x".repeat(240));
        let (claim, sidecar) = claim_paths(root.path(), &name, "object");
        assert!(claim.file_name().unwrap().len() < 255);
        assert!(sidecar.file_name().unwrap().len() < 255);
    }

    // INV 9 (413 oversize): the oversize_skip state machine. `create_fresh` /
    // `update_existing` record an over-limit note in `oversize_skip` keyed by
    // its mtime; a subsequent push must skip it while unchanged and retry it
    // once it changes. The insert-on-413 arm itself needs a real 413 response
    // and stays covered by the server-gated `oversize_blob_*` integration test.

    #[tokio::test]
    async fn push_skips_an_oversize_flagged_file_without_uploading_or_deleting_it() {
        // While the note is unchanged (mtime still matches the skip entry) push
        // must not retry the upload — no server contact — and must never treat
        // the skipped note as a local deletion. It stays on disk, unsynced but
        // intact.
        let root = TempRoot::new();
        std::fs::write(root.path().join("big.md"), "too big for the server").unwrap();
        let file = local_files(root.path()).remove(0);

        let mut state = connected();
        state.oversize_skip.insert(file.name.clone(), file.mtime);

        let (summary, next) = push(&state, root.path(), &no_progress, &no_pre)
            .await
            .unwrap();

        assert_eq!(summary.uploaded, 0);
        assert_eq!(
            summary.conflicts, 1,
            "the skipped oversize note is surfaced as a conflict"
        );
        assert!(
            summary.failures.is_empty(),
            "a matching-mtime skip must not contact the server"
        );
        assert!(
            root.path().join("big.md").exists(),
            "a skipped oversize note must not be deleted"
        );
        assert!(
            !next.object_map.contains_key(&file.name),
            "an un-uploaded note stays unmapped, never tombstoned"
        );
    }

    #[tokio::test]
    async fn push_retries_an_oversize_flagged_file_after_its_mtime_changes() {
        // Once the note changes, its mtime no longer matches the skip entry, so
        // the skip gate opens and push attempts the upload again. Offline that
        // attempt surfaces as an Upload failure (the test server is
        // unreachable), NOT another silent oversize skip — proving the note is
        // no longer stuck.
        let root = TempRoot::new();
        std::fs::write(root.path().join("big.md"), "shrunk").unwrap();
        let file = local_files(root.path()).remove(0);

        let mut state = connected();
        // A stale skip entry: recorded against an earlier version of the note.
        state
            .oversize_skip
            .insert(file.name.clone(), file.mtime - 1);

        let (summary, _next) = push(&state, root.path(), &no_progress, &no_pre)
            .await
            .unwrap();

        assert_eq!(
            summary.conflicts, 0,
            "a stale-mtime skip must not suppress the retry"
        );
        assert!(
            summary
                .failures
                .iter()
                .any(|f| f.kind == FailureKind::Upload),
            "the note left the skip path and attempted a real upload"
        );
        assert!(
            root.path().join("big.md").exists(),
            "a failed retry must not lose the note"
        );
    }

    // INV 7 (F32 crash-window): only a completed pull may advance pull_cursor.
    #[tokio::test]
    async fn push_preserves_the_pull_cursor() {
        // If push moved the cursor, a crash after push but before the following
        // pull would skip every peer change past the old cursor on restart.
        // Push must return the cursor untouched.
        let root = TempRoot::new();
        std::fs::write(root.path().join("note.md"), "synced body").unwrap();
        let file = local_files(root.path()).remove(0);

        let mut state = connected();
        state.pull_cursor = 42;
        state.max_version = 42;
        // The one local file is already current in the map (mtime + size match),
        // so push has nothing to upload and never contacts the server.
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

        let (summary, next) = push(&state, root.path(), &no_progress, &no_pre)
            .await
            .unwrap();

        assert!(
            summary.failures.is_empty(),
            "an up-to-date file must not contact the server"
        );
        assert_eq!(summary.uploaded, 0);
        assert_eq!(
            next.pull_cursor, 42,
            "push must not advance the pull cursor"
        );
    }
}
