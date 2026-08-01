//! What a sync run writes into the instance journal.
//!
//! One `sync_run` event per cycle: why it ran, how long each phase took, what it
//! moved, the version watermarks either side of it, and the per-file decisions
//! the summary counters throw away. The worst sync incidents this project has
//! had (conflict-copy spam, the 1081-object explosion) came from usage nobody
//! scripted and were diagnosed by forensic archaeology; this turns that into a
//! query. See docs/plan/agentic-first.md §3 and docs/spec/sync.md.
//!
//! Everything here is observation only. Nothing in this module can change what a
//! cycle decides, and a disabled journal costs one null check per run.

use std::time::Instant;

use futo_notes_core::journal::Journal;
use serde::Serialize;

use crate::checkpoint::ConnectedState;
use crate::sync::{decision, ReconcileDecision, SyncErrorKind, SyncSummary};

/// The event type a finished cycle writes — successful or not.
pub(crate) const SYNC_RUN_EVENT: &str = "sync_run";

/// Why a cycle ran. Every real run comes from the manual entry point or one of
/// the live loop's four arms, and which one fired is the first question a sync
/// investigation asks — the value is discarded at the call site otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncTrigger {
    /// "Sync now", or a shell calling `SyncSession::sync` directly.
    Manual,
    /// The catch-up cycle that runs the moment the live stream connects.
    LiveCatchUp,
    /// A debounced local edit (`note_changed`).
    LocalChange,
    /// A debounced SSE `ready`/`change` from the server.
    RemoteChange,
    /// The live loop's periodic safety poll.
    SafetyPoll,
    /// A cycle driven by something that has not declared itself — the
    /// compatibility wrappers in `lib.rs` and the crate's own unit tests.
    Unspecified,
}

/// Where one cycle journals, and why it ran. Constructed per cycle at the
/// session layer and passed down by reference so the write happens once, at the
/// only point where the whole run is visible.
pub(crate) struct SyncRunJournal {
    journal: Journal,
    trigger: SyncTrigger,
}

impl SyncRunJournal {
    pub(crate) fn new(journal: Journal, trigger: SyncTrigger) -> Self {
        Self { journal, trigger }
    }

    /// A run that journals nothing: the default for a shell with no resolved
    /// data directory, and for the `lib.rs` compatibility wrappers.
    pub(crate) fn disabled() -> Self {
        Self::new(Journal::disabled(), SyncTrigger::Unspecified)
    }

    /// Writes the one event for this cycle. A failed cycle is journaled too —
    /// that is the run someone will want to read.
    pub(crate) fn record(
        &self,
        before: &ConnectedState,
        after: &ConnectedState,
        phases: PhaseTimings,
        result: Result<&SyncSummary, &SyncErrorKind>,
    ) {
        if !self.journal.is_enabled() {
            return;
        }
        let summary = result.ok();
        self.journal.record(
            SYNC_RUN_EVENT,
            &SyncRunRecord {
                trigger: self.trigger,
                outcome: if result.is_ok() { "ok" } else { "failed" },
                error: result.err().map(SyncErrorKind::message),
                phases,
                counts: summary.map(RunCounts::of).unwrap_or_default(),
                watermarks: Watermarks {
                    before: Watermark::of(before),
                    after: Watermark::of(after),
                },
                decisions: summary.map(SyncSummary::decisions).unwrap_or_default(),
            },
        );
    }
}

/// Wall-clock milliseconds per phase of the push-first cycle. `bootstrap` is the
/// virgin-state pull that precedes the push and is zero on every later run;
/// there is no separate reconcile phase in this crate — reconcile decisions
/// happen inside push and pull, and are journaled per file.
#[derive(Debug, Default, Clone, Copy, Serialize)]
pub(crate) struct PhaseTimings {
    pub(crate) bootstrap_ms: u64,
    pub(crate) push_ms: u64,
    pub(crate) pull_ms: u64,
    pub(crate) total_ms: u64,
}

/// Measures one phase without the caller having to hold an `Instant`.
pub(crate) fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

#[derive(Serialize)]
struct SyncRunRecord<'a> {
    trigger: SyncTrigger,
    outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    phases: PhaseTimings,
    counts: RunCounts,
    watermarks: Watermarks,
    decisions: &'a [ReconcileDecision],
}

#[derive(Debug, Default, Serialize)]
struct RunCounts {
    pushed: u32,
    pulled: u32,
    deleted: u32,
    conflicts: u32,
    local_writes: u32,
    failures: usize,
    renames: usize,
    /// Files the server refused as too large (HTTP 413). Folded into
    /// `conflicts` by the summary, so it has to be counted from the decisions.
    oversize_skips: usize,
    /// Remote deletions this cycle applied or parked — likewise invisible in
    /// the counters, which only see `deleted`.
    tombstones: usize,
}

impl RunCounts {
    fn of(summary: &SyncSummary) -> Self {
        let taken = |name: &'static str| {
            summary
                .decisions()
                .iter()
                .filter(|entry| entry.decision == name)
                .count()
        };
        Self {
            pushed: summary.uploaded,
            pulled: summary.downloaded,
            deleted: summary.deleted,
            conflicts: summary.conflicts,
            local_writes: summary.local_writes_applied,
            failures: summary.failures.len(),
            renames: summary.renamed.len(),
            oversize_skips: taken(decision::SKIPPED_OVERSIZE),
            tombstones: taken(decision::TOMBSTONE_APPLIED) + taken(decision::TOMBSTONE_PARKED),
        }
    }
}

#[derive(Serialize)]
struct Watermarks {
    before: Watermark,
    after: Watermark,
}

/// The persisted position either side of a run. A cursor that did not move while
/// objects were pulled, or an object count that jumped, is the shape of every
/// interesting sync bug this project has had.
#[derive(Serialize)]
struct Watermark {
    max_version: u64,
    pull_cursor: u64,
    tracked_objects: usize,
    oversize_skipped: usize,
}

impl Watermark {
    fn of(state: &ConnectedState) -> Self {
        Self {
            max_version: state.max_version,
            pull_cursor: state.pull_cursor,
            tracked_objects: state.object_map.len(),
            oversize_skipped: state.oversize_skip.len(),
        }
    }
}
