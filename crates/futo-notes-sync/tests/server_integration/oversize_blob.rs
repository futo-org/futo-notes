//! Oversize blob (HTTP 413) handling.

use super::*;

// ── Oversize blob (HTTP 413) handling ────────────────────────────────────
//
// Gated on `FUTO_TEST_SMALL_BLOB_SERVER` — a dev-mode server booted with a
// tiny `MAX_BLOB_BYTES` so a normal note exceeds it. Kept separate from the
// shared `FUTO_TEST_SERVER` (100 MiB default) because a tiny limit would break
// every other test. Boot + run:
//   MAX_BLOB_BYTES=4096 AUTH_MODE=dev PORT=3066 BLOB_DIR=/tmp/it-413-blobs \
//     DATABASE_URL=postgres://futo_notes:futo_notes@localhost:5433/futo_notes \
//     bun src/index.ts            # in the server repo
//   FUTO_TEST_SMALL_BLOB_SERVER=http://127.0.0.1:3066 \
//     cargo test -p futo-notes-sync --test server_integration \
//       oversize_blob -- --ignored --test-threads=1
#[tokio::test]
#[ignore = "requires FUTO_TEST_SMALL_BLOB_SERVER (dev server with a tiny MAX_BLOB_BYTES)"]
async fn oversize_blob_is_surfaced_skipped_and_recovers() {
    let server = match std::env::var("FUTO_TEST_SMALL_BLOB_SERVER") {
        Ok(s) if !s.trim().is_empty() => s,
        _ => {
            eprintln!("[skip] oversize_blob_*: set FUTO_TEST_SMALL_BLOB_SERVER to run");
            return;
        }
    };
    let vault = common::temp_vault();
    let (a, _info) = futo_notes_sync::connect(&vault, &server, common::TEST_PASSWORD)
        .await
        .expect("connect");

    // A note far larger than the server's tiny limit.
    let file = format!("{}.md", common::unique("huge"));
    std::fs::write(vault.join(&file), "x".repeat(64 * 1024)).unwrap();

    // Push: server rejects with 413 → surfaced as a conflict, NOT uploaded,
    // and marked so we won't re-upload it.
    let (s1, a) = futo_notes_sync::run_push(&a, &vault, &no_progress, &no_pre_write)
        .await
        .expect("push 1");
    assert_eq!(s1.uploaded, 0, "an oversize note must not upload");
    assert!(
        s1.conflicts >= 1,
        "an oversize note must surface (conflict count)"
    );
    assert!(
        a.oversize_skip.contains_key(&file),
        "oversize note must be marked"
    );

    // A fresh peer must NOT receive it (it never reached the server).
    let vb = common::temp_vault();
    let (b, _i) = futo_notes_sync::connect(&vb, &server, common::TEST_PASSWORD)
        .await
        .expect("B connect");
    let b = pull(&b, &vb).await;
    assert!(
        !vb.join(&file).exists(),
        "peer must not receive an oversize note"
    );

    // Push again with the unchanged file: pre-flight skip (no re-upload),
    // still surfaced, mark persists across cycles.
    let (s2, a) = futo_notes_sync::run_push(&a, &vault, &no_progress, &no_pre_write)
        .await
        .expect("push 2");
    assert_eq!(s2.uploaded, 0, "must still not upload on retry");
    assert!(s2.conflicts >= 1, "must still surface on retry");
    assert!(
        a.oversize_skip.contains_key(&file),
        "mark persists across cycles"
    );

    // Shrink the note (new content + mtime) → recovers: uploads, clears mark,
    // peer receives it. The 10ms gap guarantees a fresh mtime so the
    // mtime-keyed skip releases (defensive against coarse fs mtime resolution).
    std::thread::sleep(std::time::Duration::from_millis(10));
    std::fs::write(vault.join(&file), "small now\n").unwrap();
    let (s3, a) = futo_notes_sync::run_push(&a, &vault, &no_progress, &no_pre_write)
        .await
        .expect("push 3");
    assert_eq!(s3.uploaded, 1, "a shrunk note uploads");
    assert!(
        !a.oversize_skip.contains_key(&file),
        "mark clears once it syncs"
    );

    let _b = pull(&b, &vb).await;
    assert_eq!(
        std::fs::read_to_string(vb.join(&file)).unwrap(),
        "small now\n",
        "peer receives the note once it fits"
    );

    common::cleanup(&vault);
    common::cleanup(&vb);
}
