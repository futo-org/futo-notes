use futo_notes_core::e2ee;
use futo_notes_core::image::is_image_filename;
use futo_notes_core::merge::{three_way_merge, MergeResult};

use crate::checkpoint::ObjectState;
use crate::server::Object;

use super::super::encrypted_note::RemoteNote;
use super::super::push::PushContext;
use super::super::vault::LocalFile;
use super::super::{FailureKind, SyncFailure};

pub(super) async fn fetch_current_object(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
) -> Option<Object> {
    match context
        .http
        .object(&context.state.collection_id, &existing.object_id)
        .await
    {
        Ok(object) => Some(object),
        Err(error) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: error.status,
                detail: Some(error.message),
            });
            None
        }
    }
}

async fn fetch_merge_base(context: &PushContext<'_>, existing: &ObjectState) -> Option<String> {
    context
        .http
        .blob(&existing.blob_key, existing.size_bytes.unwrap_or(0))
        .await
        .ok()
        .and_then(|ciphertext| e2ee::aes_gcm_decrypt(&context.state.vault_key, &ciphertext).ok())
        .and_then(|plain| e2ee::unpack_note(&plain).ok())
        .map(|note| note.content)
}

pub(super) async fn merge_remote_content(
    context: &PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
    local: &str,
    remote: &RemoteNote,
) -> Option<String> {
    if remote.content == local {
        return Some(local.to_owned());
    }
    if is_image_filename(&file.name) {
        return None;
    }
    let base = fetch_merge_base(context, existing).await?;
    match three_way_merge(&base, &remote.content, local) {
        MergeResult::Clean(merged) => Some(merged),
        MergeResult::Conflict => None,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::server::stalled_http::{
        allow_network_task_to_settle, allow_timeout_task_to_finish, HangingServer, StallPoint,
    };
    use crate::server::Http;
    use crate::sync::outcome::SyncSummary;

    use super::super::test_support::{connected_state, no_pre, remote_note};
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn merge_base_fetch_deadline_scales_with_checkpoint_size() {
        let server = HangingServer::new(StallPoint::ResponseHeaders);
        let base_url = server.base_url.clone();
        let request = tokio::spawn(async move {
            let http = Http::new(&base_url).unwrap().token("token");
            let mut state = connected_state(base_url);
            let mut summary = SyncSummary::default();
            let root = std::env::temp_dir();
            let context = PushContext {
                http: &http,
                state: &mut state,
                root: &root,
                summary: &mut summary,
                pre_write: &no_pre,
                save_checkpoint: &|_, _| Ok(()),
            };
            let existing = ObjectState {
                object_id: "o1".into(),
                version: 1,
                blob_key: "blob-o1".into(),
                hash: None,
                mtime_ms: None,
                size_bytes: Some(128 * 1024),
            };
            let file = LocalFile {
                name: "a.md".into(),
                mtime: 0,
                size: 5,
            };
            merge_remote_content(
                &context,
                &file,
                &existing,
                "local",
                &remote_note("a.md", "remote"),
            )
            .await
        });
        server.wait_for_request().await;
        allow_network_task_to_settle().await;

        tokio::time::advance(Duration::from_secs(30) + Duration::from_millis(1)).await;
        allow_timeout_task_to_finish(&request).await;
        assert!(
            !request.is_finished(),
            "merge-base fetch ignored the checkpoint-recorded size"
        );

        tokio::time::advance(Duration::from_secs(1)).await;
        allow_timeout_task_to_finish(&request).await;
        assert!(
            request.is_finished(),
            "merge-base fetch had no finite deadline"
        );
        assert_eq!(request.await.unwrap(), None);
    }
}
