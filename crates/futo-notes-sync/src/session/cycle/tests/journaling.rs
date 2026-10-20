//! What the instance journal records for a cycle, successful or not.

use super::*;

// ── Instance journal (docs/plan/agentic-first.md §3 stream 1) ──
// These drive the whole push-first cycle against the in-process mutation
// server and then assert on what landed in the journal, not just on the
// summary — the point of the journal is that it survives the run.

fn sync_runs(journal_dir: &Path) -> Vec<serde_json::Value> {
    read_events(journal_dir)
        .unwrap()
        .into_iter()
        .filter(|event| event.event_type == "sync_run")
        .map(|event| event.data)
        .collect()
}

#[tokio::test]
async fn a_journaled_cycle_records_one_run_with_its_trigger_counts_and_decisions() {
    let root = TempRoot::new();
    let journal_dir = TempRoot::new();
    std::fs::write(root.0.join("new.md"), "new body").unwrap();
    let server = MutationServer::new();
    let mut connected = connected();
    connected.base_url = server.base_url.clone();
    connected.max_version = 1;
    connected.pull_cursor = 1;
    let state = Arc::new(Mutex::new(Some(connected)));
    let gate = Arc::new(Mutex::new(()));
    let no_progress = |_: crate::sync::SyncProgress| {};
    let no_pre_write = |_: &str| {};
    let journal = Journal::open(&journal_dir.0, JournalLimits::default()).unwrap();

    let summary = run_with_checkpoint(
        &state,
        &gate,
        &root.0,
        &no_progress,
        &no_pre_write,
        &checkpoint::save,
        &SyncRunJournal::new(journal.clone(), SyncTrigger::LocalChange),
    )
    .await
    .unwrap();
    drop(journal); // flushes and joins the writer thread

    let runs = sync_runs(&journal_dir.0);
    assert_eq!(runs.len(), 1, "one cycle writes exactly one sync_run event");
    let run = &runs[0];
    assert_eq!(run["trigger"], "local_change");
    assert_eq!(run["outcome"], "ok");
    assert_eq!(run["counts"]["pushed"], 1);
    assert_eq!(run["counts"]["pulled"], 0);
    assert_eq!(run["counts"]["conflicts"], 0);
    assert_eq!(run["counts"]["oversize_skips"], 0);
    assert_eq!(run["counts"]["tombstones"], 0);
    assert_eq!(run["watermarks"]["before"]["tracked_objects"], 0);
    assert_eq!(run["watermarks"]["after"]["tracked_objects"], 1);
    assert!(run["phases"]["total_ms"].is_u64());

    let decisions = run["decisions"].as_array().unwrap();
    assert_eq!(
        decisions.len(),
        1,
        "one uploaded file, one decision: {decisions:?}"
    );
    assert_eq!(decisions[0]["phase"], "push");
    assert_eq!(decisions[0]["filename"], "new.md");
    assert_eq!(decisions[0]["decision"], "uploaded_new");
    assert_eq!(decisions[0]["reason"], "not_on_server");
    assert_eq!(
        summary.uploaded, 1,
        "the journal must not change the outcome"
    );
}

#[tokio::test]
async fn a_failed_cycle_is_still_journaled_with_its_error_and_watermarks() {
    let root = TempRoot::new();
    let journal_dir = TempRoot::new();
    std::fs::write(root.0.join("new.md"), "new body").unwrap();
    let server = MutationServer::with_pull_failure();
    let mut connected = connected();
    connected.base_url = server.base_url.clone();
    connected.max_version = 1;
    connected.pull_cursor = 1;
    let state = Arc::new(Mutex::new(Some(connected)));
    let gate = Arc::new(Mutex::new(()));
    let no_progress = |_: crate::sync::SyncProgress| {};
    let no_pre_write = |_: &str| {};
    let journal = Journal::open(&journal_dir.0, JournalLimits::default()).unwrap();

    run_with_checkpoint(
        &state,
        &gate,
        &root.0,
        &no_progress,
        &no_pre_write,
        &checkpoint::save,
        &SyncRunJournal::new(journal.clone(), SyncTrigger::SafetyPoll),
    )
    .await
    .expect_err("the injected pull failure should abort the cycle");
    drop(journal);

    let runs = sync_runs(&journal_dir.0);
    assert_eq!(
        runs.len(),
        1,
        "a failed cycle is the run someone comes looking for"
    );
    let run = &runs[0];
    assert_eq!(run["trigger"], "safety_poll");
    assert_eq!(run["outcome"], "failed");
    assert!(
        run["error"].as_str().is_some_and(|error| !error.is_empty()),
        "the error must be readable from the journal: {run}"
    );
    assert_eq!(
        run["watermarks"]["after"]["tracked_objects"], 1,
        "the push that did succeed must still be visible in the after watermark"
    );
}
