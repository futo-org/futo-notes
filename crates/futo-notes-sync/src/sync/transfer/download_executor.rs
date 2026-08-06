use std::collections::VecDeque;

use crate::server::{Http, Object};

use crate::sync::chunking::{pack_smallest_first, TransferChunk};
use crate::sync::{Progress, SyncErrorKind, SyncProgress};

#[cfg(test)]
#[path = "download_executor_tests.rs"]
mod tests;

#[cfg(test)]
use super::http_transport::run_batch_job;
use super::http_transport::{run_batch_downloads, run_single_downloads};
use super::DownloadedObject;

struct DownloadProgress<'a> {
    progress: &'a Progress,
    current: usize,
    total: usize,
}

impl<'a> DownloadProgress<'a> {
    fn new(progress: &'a Progress, total: usize) -> Self {
        let progress_state = Self {
            progress,
            current: 0,
            total,
        };
        progress_state.emit();
        progress_state
    }

    fn complete(&mut self, count: usize) {
        for _ in 0..count {
            self.current += 1;
            self.emit();
        }
    }

    fn emit(&self) {
        (self.progress)(SyncProgress {
            phase: "pulling",
            current: self.current,
            total: self.total,
        });
    }
}

fn partition_downloads(objects: Vec<Object>) -> (VecDeque<Vec<Object>>, Vec<Object>) {
    let mut batches = VecDeque::new();
    let mut singles = Vec::new();
    for chunk in pack_smallest_first(objects, |object| {
        object.blob_key.as_ref().and(object.size_bytes)
    }) {
        match chunk {
            TransferChunk::Batch(objects) => batches.push_back(objects),
            TransferChunk::Single(object) => singles.push(object),
        }
    }
    (batches, singles)
}

pub(in crate::sync) async fn download_stage<F>(
    http: &Http,
    key: &[u8; 32],
    objects: Vec<Object>,
    progress: &Progress,
    mut complete: F,
) -> Result<(), SyncErrorKind>
where
    F: FnMut(Vec<DownloadedObject>) -> Result<(), SyncErrorKind>,
{
    let mut download_progress = DownloadProgress::new(progress, objects.len());
    let (batches, mut singles) = partition_downloads(objects);

    let mut record_batch = |completed: Vec<DownloadedObject>| {
        download_progress.complete(completed.len());
        complete(completed)
    };
    let (batch_fallbacks, completed_ids) =
        run_batch_downloads(http, key, batches, &mut record_batch).await?;
    singles.extend(batch_fallbacks);
    let mut record_single = |completed: Vec<DownloadedObject>| {
        download_progress.complete(completed.len());
        complete(completed)
    };
    run_single_downloads(http, key, singles, completed_ids, &mut record_single).await
}
