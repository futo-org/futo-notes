use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::task::{Id, JoinSet};

use crate::server::{batch_write_frame_size, BatchMutation, Http, Mutation};

use crate::sync::chunking::{MAX_BATCH_ENTRIES, TARGET_CHUNK_BYTES};
use crate::sync::transfer::{CandidateResult, CompletedUpload, UploadCandidate, UploadTarget};

use super::upload_batch::{run_batch, BatchOutcome};

const BATCH_CONCURRENCY: usize = 4;

enum UploadDispatch {
    Batch(UploadCandidate, BatchMutation),
    Classic(UploadCandidate),
}

pub(in crate::sync::transfer) struct UploadDispatcher {
    http: Http,
    collection: String,
    current: Vec<UploadCandidate>,
    current_bytes: u64,
    tasks: JoinSet<BatchOutcome>,
    spawned: HashMap<Id, Arc<Vec<UploadCandidate>>>,
    batch_unsupported: Arc<AtomicBool>,
}

impl UploadDispatcher {
    pub(in crate::sync::transfer) fn new(http: &Http, collection: &str) -> Self {
        Self {
            http: http.clone(),
            collection: collection.to_owned(),
            current: Vec::new(),
            current_bytes: 0,
            tasks: JoinSet::new(),
            spawned: HashMap::new(),
            batch_unsupported: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(in crate::sync::transfer) fn is_at_capacity(&self) -> bool {
        self.tasks.len() >= BATCH_CONCURRENCY
    }

    pub(in crate::sync::transfer) fn will_dispatch(&self, candidate: &UploadCandidate) -> bool {
        let size = candidate.batch_frame_size();
        size >= TARGET_CHUNK_BYTES || self.batch_would_overflow(size)
    }

    pub(in crate::sync::transfer) fn has_buffered(&self) -> bool {
        !self.current.is_empty()
    }

    pub(in crate::sync::transfer) async fn push(
        &mut self,
        candidate: UploadCandidate,
    ) -> Vec<CompletedUpload> {
        let dispatches = self.push_dispatches(candidate).await;
        self.execute_dispatches(dispatches).await
    }

    async fn push_dispatches(&mut self, candidate: UploadCandidate) -> Vec<UploadDispatch> {
        let size = candidate.batch_frame_size();
        let mut ready = Vec::new();
        if size >= TARGET_CHUNK_BYTES {
            ready.extend(self.flush_dispatches().await);
            ready.push(UploadDispatch::Classic(candidate));
            return ready;
        }
        if self.batch_would_overflow(size) {
            ready.extend(self.flush_dispatches().await);
        }
        self.current_bytes += size;
        self.current.push(candidate);
        ready
    }

    pub(in crate::sync::transfer) async fn flush(&mut self) -> Vec<CompletedUpload> {
        let dispatches = self.flush_dispatches().await;
        self.execute_dispatches(dispatches).await
    }

    async fn flush_dispatches(&mut self) -> Vec<UploadDispatch> {
        self.current_bytes = 0;
        match self.current.len() {
            0 => Vec::new(),
            1 => vec![UploadDispatch::Classic(
                self.current.pop().expect("length checked"),
            )],
            _ if self.batch_unsupported.load(Ordering::Relaxed) => self
                .current
                .drain(..)
                .map(UploadDispatch::Classic)
                .collect(),
            _ => {
                let ready = if self.is_at_capacity() {
                    self.next_completed_dispatches().await.unwrap_or_default()
                } else {
                    Vec::new()
                };
                let candidates = Arc::new(std::mem::take(&mut self.current));
                let task_candidates = candidates.clone();
                let task_http = self.http.clone();
                let task_collection = self.collection.clone();
                let unsupported = self.batch_unsupported.clone();
                let handle = self.tasks.spawn(async move {
                    run_batch(task_http, task_collection, task_candidates, unsupported).await
                });
                self.spawned.insert(handle.id(), candidates);
                ready
            }
        }
    }

    pub(in crate::sync::transfer) async fn next_completed(
        &mut self,
    ) -> Option<Vec<CompletedUpload>> {
        let dispatches = self.next_completed_dispatches().await?;
        Some(self.execute_dispatches(dispatches).await)
    }

    async fn next_completed_dispatches(&mut self) -> Option<Vec<UploadDispatch>> {
        let joined = self.tasks.join_next_with_id().await?;
        Some(match joined {
            Ok((id, outcome)) => {
                let candidates = remove_spawned_candidates(&mut self.spawned, id);
                dispatch_batch_outcome(candidates, outcome)
            }
            Err(error) => {
                let candidates = remove_spawned_candidates(&mut self.spawned, error.id());
                dispatch_classic(candidates)
            }
        })
    }

    fn batch_would_overflow(&self, next_size: u64) -> bool {
        !self.current.is_empty()
            && (self.current_bytes + next_size > TARGET_CHUNK_BYTES
                || self.current.len() >= MAX_BATCH_ENTRIES)
    }

    async fn execute_dispatches(&self, dispatches: Vec<UploadDispatch>) -> Vec<CompletedUpload> {
        let mut completed = Vec::with_capacity(dispatches.len());
        for dispatch in dispatches {
            let (candidate, result) = match dispatch {
                UploadDispatch::Batch(candidate, mutation) => {
                    (candidate, map_batch_mutation(mutation))
                }
                UploadDispatch::Classic(candidate) => {
                    let result =
                        execute_classic_upload(&self.http, &self.collection, &candidate).await;
                    (candidate, result)
                }
            };
            completed.push((candidate, result));
        }
        completed
    }
}

pub(in crate::sync) async fn dispatch_one_upload(
    http: &Http,
    collection: &str,
    candidate: UploadCandidate,
) -> CompletedUpload {
    let mut dispatcher = UploadDispatcher::new(http, collection);
    let mut completed = dispatcher.push(candidate).await;
    if completed.is_empty() {
        completed = dispatcher.flush().await;
    }
    completed
        .pop()
        .expect("one upload candidate produces one normalized result")
}

impl UploadCandidate {
    fn batch_frame_size(&self) -> u64 {
        let identifier = match &self.target {
            UploadTarget::Create(pending) => &pending.mutation_id,
            UploadTarget::Update(existing) => &existing.object_id,
        };
        batch_write_frame_size(identifier, self.ciphertext.len()).unwrap_or(u64::MAX)
    }
}

fn remove_spawned_candidates(
    spawned: &mut HashMap<Id, Arc<Vec<UploadCandidate>>>,
    task_id: Id,
) -> Vec<UploadCandidate> {
    let candidates = spawned
        .remove(&task_id)
        .unwrap_or_else(|| panic!("missing upload candidates for task {task_id:?}"));
    match Arc::try_unwrap(candidates) {
        Ok(candidates) => candidates,
        Err(_) => panic!("upload task retained candidate ciphertext after completion"),
    }
}

fn dispatch_batch_outcome(
    candidates: Vec<UploadCandidate>,
    outcome: BatchOutcome,
) -> Vec<UploadDispatch> {
    match outcome {
        BatchOutcome::Mutations(results) => candidates
            .into_iter()
            .zip(results)
            .map(|(candidate, result)| UploadDispatch::Batch(candidate, result))
            .collect(),
        BatchOutcome::Classic => dispatch_classic(candidates),
    }
}

fn dispatch_classic(candidates: Vec<UploadCandidate>) -> Vec<UploadDispatch> {
    candidates
        .into_iter()
        .map(UploadDispatch::Classic)
        .collect()
}

fn map_batch_mutation(result: BatchMutation) -> CandidateResult {
    match result {
        BatchMutation::Created(write) => CandidateResult::Created(write),
        BatchMutation::Replayed(write) => CandidateResult::Replayed(write),
        BatchMutation::Updated(write) => CandidateResult::Updated(write),
        BatchMutation::Conflict(conflict) => CandidateResult::Conflict(conflict),
        BatchMutation::NotFound => CandidateResult::Failed(Some(404)),
        BatchMutation::TooLarge => CandidateResult::TooLarge,
        BatchMutation::Error(error) => {
            eprintln!("[sync] batch upload entry failed: {error}");
            CandidateResult::Failed(None)
        }
    }
}

async fn execute_classic_upload(
    http: &Http,
    collection: &str,
    candidate: &UploadCandidate,
) -> CandidateResult {
    match &candidate.target {
        UploadTarget::Update(existing) => {
            normalize_update(
                http,
                collection,
                &existing.object_id,
                existing.version + 1,
                candidate.ciphertext.clone(),
            )
            .await
        }
        UploadTarget::Create(pending) => {
            normalize_create(
                http,
                collection,
                &pending.mutation_id,
                candidate.ciphertext.clone(),
            )
            .await
        }
    }
}

async fn normalize_create(
    http: &Http,
    collection: &str,
    mutation_id: &str,
    ciphertext: Vec<u8>,
) -> CandidateResult {
    match http
        .create_object(collection, mutation_id, ciphertext)
        .await
    {
        Ok(created) if created.replayed == Some(false) => CandidateResult::Created(created.write),
        Ok(created) => CandidateResult::Replayed(created.write),
        Err(error) if error.is(413) => CandidateResult::TooLarge,
        Err(error) => CandidateResult::Failed(error.status),
    }
}

async fn normalize_update(
    http: &Http,
    collection: &str,
    object_id: &str,
    version: u64,
    ciphertext: Vec<u8>,
) -> CandidateResult {
    match http
        .update_object(collection, object_id, version, ciphertext)
        .await
    {
        Ok(Mutation::Written(write)) => CandidateResult::Updated(write),
        Ok(Mutation::Conflict(conflict)) => CandidateResult::Conflict(conflict),
        Err(error) if error.is(413) => CandidateResult::TooLarge,
        Err(error) => CandidateResult::Failed(error.status),
    }
}
