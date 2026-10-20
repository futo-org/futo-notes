//! Perf harness: first-connect reconcile on a large vault.

use super::*;

// ── Perf: first-connect reconcile on a large vault (issue #8) ─────────────
//
// Measurement harness, not an assertion suite: seeds N notes through client
// A's normal push path, then times a FRESH client's full first sync (connect
// + reconcile-adopt of every object). Run against a server WITH the batch
// endpoint and one without to get the before/after numbers:
//
//   FUTO_TEST_SERVER=http://127.0.0.1:3005 FUTO_PERF_NOTES=500 \
//     cargo test -p futo-notes-sync --test server_integration \
//     measure_first_sync_large_vault -- --ignored --nocapture --test-threads=1
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER; perf harness, prints timings"]
async fn measure_first_sync_large_vault() {
    if common::skip_if_no_server("measure_first_sync_large_vault") {
        return;
    }
    let server = common::server_url().unwrap();
    let n: usize = std::env::var("FUTO_PERF_NOTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);

    // Seed: client A pushes n notes (unique names so reruns don't collide).
    let (a, va) = fresh_client(&server).await;
    let run_tag = common::unique("perf");
    for i in 0..n {
        std::fs::write(
            va.join(format!("{run_tag}-{i}.md")),
            format!("perf note {i}\nbody body body\n"),
        )
        .unwrap();
    }
    let started = std::time::Instant::now();
    let (push_summary, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("seed push");
    assert_eq!(
        push_summary.uploaded as usize, n,
        "all seed notes must upload"
    );
    println!("seed push of {n} notes: {:?}", started.elapsed());

    // Measure: a fresh device's first sync (connect + empty-map reconcile).
    let vb = common::temp_vault();
    let connect_started = std::time::Instant::now();
    let (b, _info) = futo_notes_sync::connect(&vb, &server, common::TEST_PASSWORD)
        .await
        .expect("B connect");
    let connect_elapsed = connect_started.elapsed();

    let sync_started = std::time::Instant::now();
    let (summary, _b) = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B first sync");
    let sync_elapsed = sync_started.elapsed();

    assert!(
        (summary.downloaded as usize) >= n,
        "fresh device must adopt at least the {n} seeded notes (got {})",
        summary.downloaded
    );
    assert!(
        summary.failures.is_empty(),
        "no failures expected: {:?}",
        summary.failures
    );
    println!(
        "first sync of {} objects: connect {:?} + sync {:?} (downloaded {})",
        summary.downloaded, connect_elapsed, sync_elapsed, summary.downloaded
    );

    common::cleanup(&va);
    common::cleanup(&vb);
}
