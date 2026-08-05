use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::task::JoinSet;

use crate::server::{BatchBlobEntry, BatchBlobStatus, Http, Object};

use super::download_failure;
use crate::sync::encrypted_note::decrypt_bytes;
use crate::sync::transfer::DownloadedObject;
use crate::sync::transfer_retry::{batch_error_action, BatchErrorAction};
use crate::sync::SyncErrorKind;

const BATCH_CONCURRENCY: usize = 4;
const MAX_OMITTED_RETRIES: usize = 3;

pub(in crate::sync::transfer) struct BatchResult {
    pub(in crate::sync::transfer) completed: Vec<DownloadedObject>,
    pub(in crate::sync::transfer) retry_as_singles: Vec<Object>,
}

struct ClassifiedBatchResponse {
    completed: Vec<DownloadedObject>,
    omitted: Vec<Object>,
    retry_as_singles: Vec<Object>,
}

fn claim_omitted_retry(retries: &mut usize) -> bool {
    if *retries >= MAX_OMITTED_RETRIES {
        return false;
    }
    *retries += 1;
    true
}

async fn request_batch(
    http: &Http,
    objects: &[Object],
    batch_unsupported: &AtomicBool,
) -> Result<Vec<BatchBlobEntry>, Vec<Object>> {
    if batch_unsupported.load(Ordering::Relaxed) {
        return Err(objects.to_vec());
    }
    let keys = objects
        .iter()
        .filter_map(|object| object.blob_key.clone())
        .collect::<Vec<_>>();
    debug_assert_eq!(keys.len(), objects.len());
    let expected_bytes = objects.iter().filter_map(|object| object.size_bytes).sum();
    let mut attempt = 0;
    loop {
        match http.blobs_batch(&keys, expected_bytes).await {
            Ok(entries) => return Ok(entries),
            Err(error) => match batch_error_action(&error, attempt) {
                BatchErrorAction::Unsupported => {
                    batch_unsupported.store(true, Ordering::Relaxed);
                    return Err(objects.to_vec());
                }
                BatchErrorAction::Retry(backoff) => {
                    eprintln!(
                        "[sync] batch download attempt {} failed: {error}",
                        attempt + 1
                    );
                    tokio::time::sleep(backoff).await;
                    attempt += 1;
                }
                BatchErrorAction::Degrade => {
                    eprintln!("[sync] batch download failed: {error}");
                    return Err(objects.to_vec());
                }
            },
        }
    }
}

fn classify_batch_response(
    key: &[u8; 32],
    pending: &[Object],
    entries: Vec<BatchBlobEntry>,
) -> ClassifiedBatchResponse {
    let mut retry_as_singles = Vec::new();
    let mut by_key = HashMap::<&str, &Object>::with_capacity(pending.len());
    for object in pending {
        if let Some(blob_key) = object.blob_key.as_deref() {
            if let Some(previous) = by_key.insert(blob_key, object) {
                retry_as_singles.push(previous.clone());
            }
        }
    }

    let mut completed = Vec::with_capacity(entries.len());
    let mut covered = HashSet::with_capacity(entries.len());
    let mut omitted = Vec::new();
    for entry in entries {
        let Some(&object) = by_key.get(entry.key.as_str()) else {
            eprintln!(
                "[sync] batch download response contained unrequested key {}",
                entry.key
            );
            continue;
        };
        if !covered.insert(entry.key.clone()) {
            continue;
        }
        match entry.status {
            BatchBlobStatus::Ok => {
                completed.push((object.clone(), decrypt_bytes(key, object, &entry.bytes)))
            }
            BatchBlobStatus::Missing => completed.push(download_failure(object.clone(), Some(404))),
            BatchBlobStatus::Omitted => omitted.push(object.clone()),
        }
    }

    retry_as_singles.extend(
        pending
            .iter()
            .filter(|object| {
                let blob_key = object.blob_key.as_deref().unwrap_or_default();
                !covered.contains(blob_key)
            })
            .cloned(),
    );

    ClassifiedBatchResponse {
        completed,
        omitted,
        retry_as_singles,
    }
}

pub(in crate::sync::transfer) async fn run_batch_job(
    http: Http,
    key: [u8; 32],
    objects: Vec<Object>,
    batch_unsupported: Arc<AtomicBool>,
) -> BatchResult {
    let mut completed = Vec::with_capacity(objects.len());
    let mut retry_as_singles = Vec::new();
    let mut pending = objects;
    let mut omitted_retries = 0;

    while !pending.is_empty() {
        let entries = match request_batch(&http, &pending, &batch_unsupported).await {
            Ok(entries) => entries,
            Err(objects) => {
                retry_as_singles.extend(objects);
                break;
            }
        };
        let classified = classify_batch_response(&key, &pending, entries);
        completed.extend(classified.completed);
        retry_as_singles.extend(classified.retry_as_singles);

        if classified.omitted.is_empty() {
            break;
        }
        if !claim_omitted_retry(&mut omitted_retries) {
            retry_as_singles.extend(classified.omitted);
            break;
        }
        pending = classified.omitted;
    }

    BatchResult {
        completed,
        retry_as_singles,
    }
}

fn spawn_batch(
    tasks: &mut JoinSet<BatchResult>,
    spawned: &mut HashMap<tokio::task::Id, Vec<Object>>,
    http: &Http,
    key: &[u8; 32],
    batches: &mut VecDeque<Vec<Object>>,
    batch_unsupported: &Arc<AtomicBool>,
) {
    let objects = batches.pop_front().expect("batch queue checked");
    let panic_objects = objects.clone();
    let task_http = http.clone();
    let task_key = *key;
    let unsupported = batch_unsupported.clone();
    let handle =
        tasks.spawn(async move { run_batch_job(task_http, task_key, objects, unsupported).await });
    spawned.insert(handle.id(), panic_objects);
}

fn fill_batch_slots(
    tasks: &mut JoinSet<BatchResult>,
    spawned: &mut HashMap<tokio::task::Id, Vec<Object>>,
    http: &Http,
    key: &[u8; 32],
    batches: &mut VecDeque<Vec<Object>>,
    batch_unsupported: &Arc<AtomicBool>,
) {
    while tasks.len() < BATCH_CONCURRENCY && !batches.is_empty() {
        spawn_batch(tasks, spawned, http, key, batches, batch_unsupported);
    }
}

fn apply_completed_batch<F>(
    batch: BatchResult,
    complete: &mut F,
    retry_as_singles: &mut Vec<Object>,
    completed_ids: &mut HashSet<String>,
) -> Result<(), SyncErrorKind>
where
    F: FnMut(Vec<DownloadedObject>) -> Result<(), SyncErrorKind>,
{
    completed_ids.extend(batch.completed.iter().map(|(object, _)| object.id.clone()));
    if !batch.completed.is_empty() {
        complete(batch.completed)?;
    }
    retry_as_singles.extend(batch.retry_as_singles);
    Ok(())
}

fn apply_panicked_batch<F>(
    objects: Vec<Object>,
    complete: &mut F,
    completed_ids: &mut HashSet<String>,
) -> Result<(), SyncErrorKind>
where
    F: FnMut(Vec<DownloadedObject>) -> Result<(), SyncErrorKind>,
{
    let failed = objects
        .into_iter()
        .map(|object| {
            completed_ids.insert(object.id.clone());
            download_failure(object, None)
        })
        .collect();
    complete(failed)
}

pub(in crate::sync::transfer) async fn run_batch_downloads<F>(
    http: &Http,
    key: &[u8; 32],
    mut batches: VecDeque<Vec<Object>>,
    complete: &mut F,
) -> Result<(Vec<Object>, HashSet<String>), SyncErrorKind>
where
    F: FnMut(Vec<DownloadedObject>) -> Result<(), SyncErrorKind>,
{
    let batch_unsupported = Arc::new(AtomicBool::new(false));
    let mut tasks = JoinSet::new();
    let mut spawned = HashMap::new();
    fill_batch_slots(
        &mut tasks,
        &mut spawned,
        http,
        key,
        &mut batches,
        &batch_unsupported,
    );
    let mut retry_as_singles = Vec::new();
    let mut completed_ids = HashSet::new();
    while let Some(joined) = tasks.join_next_with_id().await {
        match joined {
            Ok((id, batch)) => {
                spawned.remove(&id);
                apply_completed_batch(batch, complete, &mut retry_as_singles, &mut completed_ids)?;
            }
            Err(error) => {
                if let Some(objects) = spawned.remove(&error.id()) {
                    apply_panicked_batch(objects, complete, &mut completed_ids)?;
                }
            }
        }
        fill_batch_slots(
            &mut tasks,
            &mut spawned,
            http,
            key,
            &mut batches,
            &batch_unsupported,
        );
    }
    Ok((retry_as_singles, completed_ids))
}

#[cfg(test)]
mod tests {
    use super::claim_omitted_retry;

    #[test]
    fn omitted_entries_retry_three_times_before_degrading() {
        let mut retries = 0;
        assert!(claim_omitted_retry(&mut retries));
        assert!(claim_omitted_retry(&mut retries));
        assert!(claim_omitted_retry(&mut retries));
        assert!(!claim_omitted_retry(&mut retries));
        assert_eq!(retries, 3);
    }
}
