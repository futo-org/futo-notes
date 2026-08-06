use crate::checkpoint::{ConnectedState, PendingCreate};
use crate::sync::outcome::note_id;
use crate::sync::outcome::record_checkpoint_failure;
use crate::sync::push::PushContext;
use crate::sync::transfer::{UploadCandidate, UploadTarget};
use crate::sync::vault::LocalFile;
use crate::sync::SyncErrorKind;

mod fresh;
mod replay;
mod restart;

pub(in crate::sync) use fresh::create_fresh;
pub(super) use replay::apply_replayed_create;
pub(in crate::sync) use restart::recover_pending_creates;

pub(in crate::sync) struct Upload<'a> {
    pub(in crate::sync) name: &'a str,
    pub(in crate::sync) content: &'a str,
    pub(in crate::sync) hash: String,
    pub(in crate::sync) size: u64,
    pub(in crate::sync) mtime: i64,
    pub(in crate::sync) reason: &'static str,
}

impl Upload<'_> {
    fn into_candidate(self, target: UploadTarget, ciphertext: Vec<u8>) -> UploadCandidate {
        UploadCandidate {
            file: LocalFile {
                name: self.name.into(),
                mtime: self.mtime,
                size: self.size,
            },
            target,
            content: self.content.into(),
            hash: self.hash,
            ciphertext,
            local_was_rename: false,
        }
    }
}

fn fatal_upload_error(status: Option<u16>, action: &str) -> SyncErrorKind {
    let message = status
        .map(|status| format!("upload follow-up failed during {action} (HTTP {status})"))
        .unwrap_or_else(|| format!("upload follow-up failed during {action}"));
    match status {
        Some(401) => SyncErrorKind::Auth(message),
        Some(404) => SyncErrorKind::CollectionGone(message),
        _ => SyncErrorKind::Http(message),
    }
}

fn fresh_pending_create(name: &str, hash: String, size_bytes: u64) -> PendingCreate {
    PendingCreate {
        mutation_id: uuid::Uuid::now_v7().to_string(),
        original_name: name.into(),
        hash,
        size_bytes,
    }
}

fn discard_create_identity(state: &mut ConnectedState, name: &str) {
    state.pending_creates.remove(name);
    state.object_map.remove(name);
    state.oversize_skip.remove(name);
}

fn settle_deleted_replay(context: &mut PushContext<'_>, name: &str) {
    discard_create_identity(context.state, name);
    context.summary.deleted += 1;
    context.summary.deleted_ids.push(note_id(name));
}

fn discard_tombstoned_create_and_stop(
    context: &mut PushContext<'_>,
    name: &str,
    message: &str,
) -> SyncErrorKind {
    discard_create_identity(context.state, name);
    if (context.save_checkpoint)(context.root, context.state).is_err() {
        record_checkpoint_failure(context.summary);
    }
    SyncErrorKind::Http(message.into())
}
