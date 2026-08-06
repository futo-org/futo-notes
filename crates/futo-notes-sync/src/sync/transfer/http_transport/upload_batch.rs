use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::server::{BatchMutation, BatchWriteEntry, BatchWriteOperation, Http};
use crate::sync::transfer_retry::{batch_error_action, BatchErrorAction};

use crate::sync::transfer::{UploadCandidate, UploadTarget};

pub(super) enum BatchOutcome {
    Mutations(Vec<BatchMutation>),
    Classic,
}

fn wire_entry(candidate: &UploadCandidate) -> BatchWriteEntry {
    let operation = match &candidate.target {
        UploadTarget::Update(existing) => BatchWriteOperation::Update {
            object_id: existing.object_id.clone(),
            version: existing.version + 1,
        },
        UploadTarget::Create(pending) => BatchWriteOperation::Create {
            mutation_id: pending.mutation_id.clone(),
        },
    };
    BatchWriteEntry {
        operation,
        ciphertext: candidate.ciphertext.clone(),
    }
}

async fn request_batch(
    http: &Http,
    collection: &str,
    entries: &[BatchWriteEntry],
    batch_unsupported: &AtomicBool,
) -> Option<Vec<BatchMutation>> {
    if batch_unsupported.load(Ordering::Relaxed) {
        return None;
    }

    let mut attempt = 0;
    loop {
        match http.write_objects_batch(collection, entries).await {
            Ok(results) => return Some(results),
            Err(error) => match batch_error_action(&error, attempt) {
                BatchErrorAction::Unsupported => {
                    batch_unsupported.store(true, Ordering::Relaxed);
                    return None;
                }
                BatchErrorAction::Retry(backoff) => {
                    eprintln!(
                        "[sync] batch upload attempt {} failed: {error}",
                        attempt + 1
                    );
                    tokio::time::sleep(backoff).await;
                    attempt += 1;
                }
                BatchErrorAction::Degrade => {
                    eprintln!("[sync] batch upload failed: {error}");
                    return None;
                }
            },
        }
    }
}

pub(super) async fn run_batch(
    http: Http,
    collection: String,
    candidates: Arc<Vec<UploadCandidate>>,
    batch_unsupported: Arc<AtomicBool>,
) -> BatchOutcome {
    let entries = candidates.iter().map(wire_entry).collect::<Vec<_>>();
    match request_batch(&http, &collection, &entries, &batch_unsupported).await {
        Some(results) => BatchOutcome::Mutations(results),
        None => BatchOutcome::Classic,
    }
}
