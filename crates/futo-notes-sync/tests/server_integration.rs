//! Production-readiness suite: drives the FULL sync-server API through the real
//! native Rust `SyncSession` path against a live server,
//! plus raw-HTTP checks for endpoints the native client doesn't wrap and the
//! error contract.
//!
//! Gated on `FUTO_TEST_SERVER`; run single-threaded (shared dev vault):
//!   FUTO_TEST_SERVER=http://127.0.0.1:3005 \
//!     cargo test -p futo-notes-sync --test server_integration -- --ignored --test-threads=1

mod common;

use std::path::Path;
use std::path::PathBuf;

use futo_notes_sync::state::ConnectedState;
use futo_notes_sync::SyncProgress;

/// No-op sync hooks (no progress UI, no watcher to suppress in the test).
fn no_progress(_p: SyncProgress) {}
fn no_pre_write(_f: &str) {}

/// Connect a fresh throwaway client (its own empty vault).
async fn fresh_client(server: &str) -> (ConnectedState, PathBuf) {
    let vault = common::temp_vault();
    let (state, _info) = futo_notes_sync::connect(&vault, server, common::TEST_PASSWORD)
        .await
        .expect("connect");
    (state, vault)
}

async fn pull(state: &ConnectedState, vault: &Path) -> ConnectedState {
    futo_notes_sync::run_pull(state, vault, state.pull_cursor, &no_progress, &no_pre_write)
        .await
        .expect("pull")
        .1
}

async fn dev_login(server: &str) -> String {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{server}/api/auth/dev/login"))
        .json(&serde_json::json!({"email":"local@futo-notes.local","name":"FUTO Notes"}))
        .send()
        .await
        .expect("dev login");
    let v: serde_json::Value = res.json().await.expect("login json");
    v["token"].as_str().expect("token").to_owned()
}

async fn create_collection_raw(server: &str, token: &str) -> String {
    let res = reqwest::Client::new()
        .post(format!("{server}/api/collections"))
        .bearer_auth(token)
        .send()
        .await
        .expect("create collection");
    let v: serde_json::Value = res.json().await.expect("collection json");
    v["collection"]["id"].as_str().expect("collection id").to_owned()
}

async fn post_blob_object_raw(server: &str, token: &str, cid: &str, body: &[u8]) {
    let res = reqwest::Client::new()
        .post(format!("{server}/api/collections/{cid}/blob-objects"))
        .bearer_auth(token)
        .header("content-type", "application/octet-stream")
        .body(body.to_vec())
        .send()
        .await
        .expect("post blob object");
    assert!(res.status().is_success(), "post blob-object failed: {}", res.status());
}

/// Delete every collection the token's user owns (test cleanup so a keyless or
/// stale vault doesn't leak into the shared singleton dev user's next test).
async fn delete_all_collections_raw(server: &str, token: &str) {
    let http = reqwest::Client::new();
    let res = http
        .get(format!("{server}/api/collections"))
        .bearer_auth(token)
        .send()
        .await
        .expect("list collections");
    let v: serde_json::Value = res.json().await.expect("collections json");
    if let Some(arr) = v["collections"].as_array() {
        for c in arr {
            if let Some(id) = c["id"].as_str() {
                let _ = http
                    .delete(format!("{server}/api/collections/{id}"))
                    .bearer_auth(token)
                    .send()
                    .await;
            }
        }
    }
}

// ── Connect / auth / collections / key material ──────────────────────────

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn connect_bootstrap_and_shared_vault() {
    if common::skip_if_no_server("connect_bootstrap_and_shared_vault") {
        return;
    }
    let server = common::server_url().unwrap();
    let va = common::temp_vault();
    let (_sa, info_a) = futo_notes_sync::connect(&va, &server, common::TEST_PASSWORD)
        .await
        .expect("A connect");
    assert_eq!(info_a.auth_mode, "dev");
    assert!(!info_a.user_id.is_empty());
    assert!(!info_a.collection_id.is_empty());

    // A second client with the same password unwraps the SAME vault — proving
    // GET/PUT key material + the fixed dev identity (one user/collection).
    let vb = common::temp_vault();
    let (_sb, info_b) = futo_notes_sync::connect(&vb, &server, common::TEST_PASSWORD)
        .await
        .expect("B connect");
    assert_eq!(info_b.collection_id, info_a.collection_id);
    assert_eq!(info_b.user_id, info_a.user_id);
    common::cleanup(&va);
    common::cleanup(&vb);
}

/// Regression for the single-vault invariant: two devices that set up sync
/// against the SAME fresh server *concurrently* must converge on ONE vault, not
/// fork into two. Pre-fix the server minted a fresh collection (and a fresh
/// vault key) for each racing connect, so the two devices ended up isolated —
/// the silent split-brain self-hosters reported. This test fails pre-fix (the
/// collection ids diverge) and passes once the server enforces one vault per
/// account + first-write-wins key material.
///
/// Run against a FRESH/clean-DB server (no pre-existing collection), since the
/// race only manifests when both connects see an empty collection list.
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER (clean DB)"]
async fn concurrent_connect_converges_to_one_vault() {
    if common::skip_if_no_server("concurrent_connect_converges_to_one_vault") {
        return;
    }
    let server = common::server_url().unwrap();
    let va = common::temp_vault();
    let vb = common::temp_vault();

    // Pre-create the singleton user so the two concurrent connects don't race on
    // the dev-login user upsert (a dev-mode-only artifact: onConflict targets
    // `email` but a concurrent insert also trips the `sub` unique index). This
    // isolates the behavior under test — the collection/vault race.
    let _ = dev_login(&server).await;

    // Both devices connect at the same instant — the split-brain race.
    let (ra, rb) = tokio::join!(
        futo_notes_sync::connect(&va, &server, common::TEST_PASSWORD),
        futo_notes_sync::connect(&vb, &server, common::TEST_PASSWORD),
    );
    let (sa, info_a) = ra.expect("A connect");
    let (sb, info_b) = rb.expect("B connect");

    assert_eq!(
        info_a.collection_id, info_b.collection_id,
        "concurrent connects must land on ONE vault, not fork into two \
         (got {} vs {})",
        info_a.collection_id, info_b.collection_id
    );

    // Same vault ⇒ a note A pushes is visible to B. This also catches the
    // key-material fork (same collection id but different vault keys): if B
    // unwrapped a different key, the pulled blob would fail to decrypt.
    let file = format!("{}.md", common::unique("converge"));
    std::fs::write(va.join(&file), "one vault\n").unwrap();
    let (_c, _sa2) = futo_notes_sync::run_push(&sa, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push");
    let _sb2 = pull(&sb, &vb).await;
    assert_eq!(
        std::fs::read_to_string(vb.join(&file)).unwrap(),
        "one vault\n",
        "B must see A's note — both devices share the single vault"
    );

    common::cleanup(&va);
    common::cleanup(&vb);
}

/// The desktop heal signal. When a device's persisted vault is gone from the
/// server (e.g. a duplicate collapsed by the single-vault migration), `resume()`
/// surfaces `CollectionGone` (message prefixed `collection-gone:`) — which the
/// desktop catches to re-connect — and a fresh `connect()` then lands on a live
/// vault. (Native shells already self-heal: they only ever connect().)
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn resume_after_vault_deleted_signals_collection_gone_then_reconnects() {
    if common::skip_if_no_server("resume_after_vault_deleted_signals_collection_gone_then_reconnects")
    {
        return;
    }
    let server = common::server_url().unwrap();
    let va = common::temp_vault();

    let (_s, info) = futo_notes_sync::connect(&va, &server, common::TEST_PASSWORD)
        .await
        .expect("connect");

    // Delete the vault server-side — the stand-in for the migration collapsing a
    // duplicate the device was pinned to.
    let res = reqwest::Client::new()
        .delete(format!("{server}/api/collections/{}", info.collection_id))
        .bearer_auth(&info.token)
        .send()
        .await
        .expect("delete request");
    assert!(res.status().is_success(), "delete failed: {}", res.status());

    // resume() against the now-missing vault surfaces the collection-gone signal.
    let err = futo_notes_sync::resume(
        &va,
        &server,
        &info.token,
        &info.user_id,
        &info.collection_id,
        common::TEST_PASSWORD,
    )
    .await
    .expect_err("resume must fail when the vault is gone");
    assert!(
        format!("{err}").contains("collection-gone"),
        "expected the collection-gone heal signal, got: {err}"
    );

    // The heal: a fresh connect() re-points to a live vault (a new one here,
    // since we deleted the only vault) — mirroring the desktop's connect()
    // fallback. It must not be the deleted id.
    let (_s2, info2) = futo_notes_sync::connect(&va, &server, common::TEST_PASSWORD)
        .await
        .expect("reconnect after vault deleted");
    assert_ne!(info2.collection_id, info.collection_id);

    common::cleanup(&va);
}

/// Fix 2: a collection that has objects but NO key material (an inconsistent
/// server state) must not be healed by minting a fresh vault key — that would
/// strand the existing objects under a new key. `connect()` fails hard, and
/// `resume()` reports a plain crypto error (NOT collection-gone, which would
/// trigger a reconnect → mint).
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn missing_key_with_objects_does_not_mint() {
    if common::skip_if_no_server("missing_key_with_objects_does_not_mint") {
        return;
    }
    let server = common::server_url().unwrap();

    // Operate as the singleton dev user `connect()` uses.
    let token = dev_login(&server).await;
    delete_all_collections_raw(&server, &token).await; // start from a clean vault
    let cid = create_collection_raw(&server, &token).await;
    post_blob_object_raw(&server, &token, &cid, b"ciphertext").await; // object, but no key set

    let va = common::temp_vault();
    let connect_result = futo_notes_sync::connect(&va, &server, common::TEST_PASSWORD).await;
    let resume_result = futo_notes_sync::resume(
        &va,
        &server,
        &token,
        "unused-user-id",
        &cid,
        common::TEST_PASSWORD,
    )
    .await;

    // Clean up BEFORE asserting so a failed assertion can't leak the keyless
    // vault into the next test.
    delete_all_collections_raw(&server, &token).await;
    common::cleanup(&va);

    let cerr = connect_result.expect_err("connect must not mint into a non-empty vault");
    assert!(
        format!("{cerr}").contains("refusing to mint"),
        "connect should refuse to mint, got: {cerr}"
    );
    let rerr = resume_result.expect_err("resume must fail on missing key material");
    let rmsg = format!("{rerr}");
    assert!(!rmsg.contains("collection-gone"), "missing key is not collection-gone: {rmsg}");
    assert!(rmsg.contains("vault key material missing"), "got: {rmsg}");
}

/// Fix 3: when the vault is deleted out from under a live session, `run_sync`
/// (not just cold resume) surfaces the collection-gone signal the desktop
/// re-points on — instead of a generic HTTP error that would loop forever.
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn run_sync_after_vault_deleted_signals_collection_gone() {
    if common::skip_if_no_server("run_sync_after_vault_deleted_signals_collection_gone") {
        return;
    }
    let server = common::server_url().unwrap();
    let va = common::temp_vault();

    let (state, info) = futo_notes_sync::connect(&va, &server, common::TEST_PASSWORD)
        .await
        .expect("connect");

    // Delete the vault while the session is live.
    let res = reqwest::Client::new()
        .delete(format!("{server}/api/collections/{}", info.collection_id))
        .bearer_auth(&info.token)
        .send()
        .await
        .expect("delete request");
    assert!(res.status().is_success(), "delete failed: {}", res.status());

    let err = futo_notes_sync::run_sync(&state, &va, &no_progress, &no_pre_write)
        .await
        .expect_err("sync against a deleted vault must fail");
    assert!(
        format!("{err}").contains("collection-gone"),
        "run_sync should surface collection-gone, got: {err}"
    );

    common::cleanup(&va);
}

// ── Object round-trip + cursor ───────────────────────────────────────────

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn single_note_round_trip_and_cursor_advance() {
    if common::skip_if_no_server("single_note_round_trip_and_cursor_advance") {
        return;
    }
    let server = common::server_url().unwrap();
    let (a, va) = fresh_client(&server).await;
    let before = a.max_version;

    let file = format!("{}.md", common::unique("rt"));
    std::fs::write(va.join(&file), "round trip body\n").unwrap();
    let (counts, a2) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write).await.expect("push");
    assert_eq!(counts.uploaded, 1);
    assert!(a2.max_version > before, "cursor must advance after a push");

    let (b, vb) = fresh_client(&server).await;
    let _b2 = pull(&b, &vb).await;
    assert_eq!(
        std::fs::read_to_string(vb.join(&file)).unwrap(),
        "round trip body\n"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn update_propagates() {
    if common::skip_if_no_server("update_propagates") {
        return;
    }
    let server = common::server_url().unwrap();
    let (a, va) = fresh_client(&server).await;
    let file = format!("{}.md", common::unique("upd"));
    std::fs::write(va.join(&file), "v1\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write).await.expect("push v1");

    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    assert_eq!(std::fs::read_to_string(vb.join(&file)).unwrap(), "v1\n");

    std::fs::write(va.join(&file), "v2 updated\n").unwrap();
    let (c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write).await.expect("push v2");
    assert_eq!(c.uploaded, 1, "an update is one upload (PUT)");

    let _b2 = pull(&b, &vb).await;
    assert_eq!(
        std::fs::read_to_string(vb.join(&file)).unwrap(),
        "v2 updated\n"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

// ── Conflict → 3-way merge ───────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn concurrent_edit_conflict_resolves() {
    if common::skip_if_no_server("concurrent_edit_conflict_resolves") {
        return;
    }
    let server = common::server_url().unwrap();
    let file = format!("{}.md", common::unique("conf"));

    // A creates the note; B pulls it (recording the common ancestor).
    let (a, va) = fresh_client(&server).await;
    std::fs::write(va.join(&file), "L1\nL2\nL3\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write).await.expect("A push base");
    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    assert!(vb.join(&file).exists());

    // A edits line 1 and pushes.
    std::fs::write(va.join(&file), "A1\nL2\nL3\n").unwrap();
    let (_c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write).await.expect("A push edit");

    // B edits line 3 against the stale base → PUT 409 → 3-way merge.
    std::fs::write(vb.join(&file), "L1\nL2\nB3\n").unwrap();
    let (_c, _b) = futo_notes_sync::run_push(&b, &vb, &no_progress, &no_pre_write).await.expect("B push (conflict)");

    // A clean (non-overlapping) merge keeps BOTH edits in the file; a dirty
    // merge parks B's edit in a `(conflict …)` copy. Accept either.
    let merged = std::fs::read_to_string(vb.join(&file)).unwrap_or_default();
    let both_in_main = merged.contains("A1") && merged.contains("B3");
    let conflict_copy_has_b3 = std::fs::read_dir(&vb)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.contains("conflict")
                && std::fs::read_to_string(e.path())
                    .map(|c| c.contains("B3"))
                    .unwrap_or(false)
        });
    assert!(
        both_in_main || conflict_copy_has_b3,
        "conflict not resolved without data loss; merged file = {merged:?}"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

// ── Delete + tombstone ───────────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn delete_propagates_as_tombstone() {
    if common::skip_if_no_server("delete_propagates_as_tombstone") {
        return;
    }
    let server = common::server_url().unwrap();
    let file = format!("{}.md", common::unique("del"));

    let (a, va) = fresh_client(&server).await;
    std::fs::write(va.join(&file), "to be deleted\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write).await.expect("push");

    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    assert!(vb.join(&file).exists());

    std::fs::remove_file(va.join(&file)).unwrap();
    let (c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write).await.expect("push delete");
    assert_eq!(c.deleted, 1);

    let _b2 = pull(&b, &vb).await;
    assert!(
        !vb.join(&file).exists(),
        "tombstone should have removed the file on B"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

// ── Rename / move (single PUT reusing object_id) ─────────────────────────

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn move_to_folder_propagates() {
    if common::skip_if_no_server("move_to_folder_propagates") {
        return;
    }
    let server = common::server_url().unwrap();
    let stem = common::unique("mv");
    let root_file = format!("{stem}.md");
    let moved_rel = format!("Folder/{stem}.md"); // same basename → rename pairing

    let (a, va) = fresh_client(&server).await;
    std::fs::write(va.join(&root_file), "movable\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write).await.expect("push");

    std::fs::remove_file(va.join(&root_file)).unwrap();
    std::fs::create_dir_all(va.join("Folder")).unwrap();
    std::fs::write(va.join(&moved_rel), "movable\n").unwrap();
    let (_c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write).await.expect("push move");

    let (b, vb) = fresh_client(&server).await;
    let _b2 = pull(&b, &vb).await;
    assert!(vb.join(&moved_rel).exists(), "moved note missing on B");
    assert!(
        !vb.join(&root_file).exists(),
        "old path should not exist on B"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

// ── Offline accumulation + large note ────────────────────────────────────

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn offline_accumulation_batch() {
    if common::skip_if_no_server("offline_accumulation_batch") {
        return;
    }
    let server = common::server_url().unwrap();
    let (a, va) = fresh_client(&server).await;
    let stem = common::unique("batch");
    for i in 0..5 {
        std::fs::write(va.join(format!("{stem}-{i}.md")), format!("note {i}\n")).unwrap();
    }
    let (c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write).await.expect("push batch");
    assert_eq!(c.uploaded, 5);

    let (b, vb) = fresh_client(&server).await;
    let _b2 = pull(&b, &vb).await;
    for i in 0..5 {
        assert!(vb.join(format!("{stem}-{i}.md")).exists(), "note {i} missing on B");
    }
    common::cleanup(&va);
    common::cleanup(&vb);
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn large_note_round_trip() {
    if common::skip_if_no_server("large_note_round_trip") {
        return;
    }
    let server = common::server_url().unwrap();
    let (a, va) = fresh_client(&server).await;
    let file = format!("{}.md", common::unique("large"));
    let big = "x".repeat(256 * 1024);
    std::fs::write(va.join(&file), &big).unwrap();
    let (c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write).await.expect("push large");
    assert_eq!(c.uploaded, 1);

    let (b, vb) = fresh_client(&server).await;
    let _b2 = pull(&b, &vb).await;
    assert_eq!(std::fs::read_to_string(vb.join(&file)).unwrap().len(), big.len());
    common::cleanup(&va);
    common::cleanup(&vb);
}

// ── Raw HTTP: blob lifecycle + error contract ────────────────────────────

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn raw_blob_lifecycle() {
    if common::skip_if_no_server("raw_blob_lifecycle") {
        return;
    }
    let server = common::server_url().unwrap();
    let token = dev_login(&server).await;
    let client = reqwest::Client::new();
    let payload: Vec<u8> = vec![0x00, 0x01, 0x02, b'o', b'p', b'a', b'q', b'u', b'e'];

    let res = client
        .post(format!("{server}/api/blobs"))
        .bearer_auth(&token)
        .header("content-type", "application/octet-stream")
        .body(payload.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 201, "blob upload");
    let key = res.json::<serde_json::Value>().await.unwrap()["key"]
        .as_str()
        .unwrap()
        .to_owned();

    let res = client
        .get(format!("{server}/api/blobs/{key}"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "blob download");
    assert_eq!(res.bytes().await.unwrap().as_ref(), payload.as_slice());

    let res = client
        .delete(format!("{server}/api/blobs/{key}"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 204, "blob delete");

    let res = client
        .get(format!("{server}/api/blobs/{key}"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 404, "blob gone after delete");
}

// ── Modified-time convergence ────────────────────────────────────────────
//
// The server's `updated_at` is the single authority for a note's modified
// time: every real push restamps the local file to it, and every pull
// writes it. A content-identical local touch (editor re-save, relink
// rewrite) must NOT let the toucher's local mtime win — that permanently
// diverges note-list ordering on that device from every other device.

fn mtime_of(path: &Path) -> i64 {
    futo_notes_core::files::file_mtime_ms(&std::fs::metadata(path).expect("stat"))
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn touch_without_content_change_restores_server_mtime() {
    if common::skip_if_no_server("touch_without_content_change_restores_server_mtime") {
        return;
    }
    let server = common::server_url().unwrap();
    let (a, va) = fresh_client(&server).await;
    let file = format!("{}.md", common::unique("touch-mtime"));
    let path = va.join(&file);
    std::fs::write(&path, "touch me, content stays\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("push v1");
    // After the push the local file is stamped to the server-authoritative
    // updated_at.
    let authoritative = mtime_of(&path);

    // Touch: bump the mtime two minutes forward, content unchanged.
    futo_notes_core::files::set_file_mtime_ms(&path, authoritative + 120_000).unwrap();
    let (counts, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("push after touch");

    assert_eq!(counts.uploaded, 0, "identical content must not re-upload");
    assert_eq!(
        mtime_of(&path),
        authoritative,
        "content-identical touch must be corrected back to the server's \
         updated_at, not adopted as the new modified time"
    );
    common::cleanup(&va);
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn reconcile_identical_content_converges_mtime_to_server() {
    if common::skip_if_no_server("reconcile_identical_content_converges_mtime_to_server") {
        return;
    }
    let server = common::server_url().unwrap();

    // A pushes the note; its file ends up stamped to server updated_at.
    let (a, va) = fresh_client(&server).await;
    let file = format!("{}.md", common::unique("reconcile-mtime"));
    let content = "identical on both sides\n";
    std::fs::write(va.join(&file), content).unwrap();
    let (_c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push");
    let authoritative = mtime_of(&va.join(&file));

    // B is a freshly-relinked client (empty object map) whose vault already
    // holds the SAME content with a different, newer mtime.
    let (b, vb) = fresh_client(&server).await;
    let b_path = vb.join(&file);
    std::fs::write(&b_path, content).unwrap();
    futo_notes_core::files::set_file_mtime_ms(&b_path, authoritative + 300_000).unwrap();

    // run_sync on an empty map triggers reconcile_empty_map.
    let (_summary, _b2) = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B reconcile sync");

    assert_eq!(
        mtime_of(&b_path),
        authoritative,
        "reconcile with identical content must converge the file mtime to \
         the server's updated_at so list ordering matches other devices"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn raw_error_contract() {
    if common::skip_if_no_server("raw_error_contract") {
        return;
    }
    let server = common::server_url().unwrap();
    let client = reqwest::Client::new();

    // 401: authenticated route without a token.
    let res = client
        .get(format!("{server}/api/collections"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 401, "missing token → 401");

    // 404: valid token, objects of a non-existent/not-owned collection.
    let token = dev_login(&server).await;
    let res = client
        .get(format!(
            "{server}/api/collections/00000000-0000-0000-0000-000000000000/objects?sinceVersion=0"
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 404, "unknown collection → 404");
}

// ── F1/F4/F5 data-loss regressions (native-FFI orchestration) ────────────

/// F1: a locally-edited-but-unpushed note must survive a peer edit that
/// arrives via the (now push-first) native sync path. The old native FFI
/// `sync_now`/live loop ran pull-then-push, so a peer's edit pulled in
/// OVERWROTE B's unpushed edit on disk before push could ever detect the
/// conflict — silent data loss, conflicts == 0. `run_sync` is push-first:
/// B's edit is PUT first (clean merge or conflict copy on 409), then the
/// pull runs from the pre-push cursor. B's edit must never vanish.
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn f1_native_sync_is_push_first_no_silent_overwrite() {
    if common::skip_if_no_server("f1_native_sync_is_push_first_no_silent_overwrite") {
        return;
    }
    let server = common::server_url().unwrap();
    let file = format!("{}.md", common::unique("f1-pushfirst"));

    // A creates the note; B pulls it (records the common ancestor).
    let (a, va) = fresh_client(&server).await;
    std::fs::write(va.join(&file), "L1\nL2\nL3\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push base");
    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    assert!(vb.join(&file).exists());

    // A edits and pushes (the peer change waiting on the server).
    std::fs::write(va.join(&file), "A1\nL2\nL3\n").unwrap();
    let (_c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push edit");

    // B has a debounced, UNPUSHED local edit on disk when the peer change is
    // about to be applied. This is exactly the live-SSE race the FFI loop now
    // routes through run_sync.
    std::fs::write(vb.join(&file), "L1\nL2\nB3\n").unwrap();
    let (summary, _b2) = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B push-first sync");

    // B's edit (B3) MUST survive — either merged into the canonical file or
    // parked in a conflict copy. The pre-fix pull-first path lost it entirely.
    let main = std::fs::read_to_string(vb.join(&file)).unwrap_or_default();
    let b3_in_main = main.contains("B3");
    let b3_in_conflict = std::fs::read_dir(&vb)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.contains("conflict")
                && std::fs::read_to_string(e.path())
                    .map(|c| c.contains("B3"))
                    .unwrap_or(false)
        });
    assert!(
        b3_in_main || b3_in_conflict,
        "F1: B's unpushed edit was silently overwritten; main = {main:?}, summary = {summary:?}"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

/// F4: two clients create the SAME filename → the server holds two DISTINCT
/// objects whose names collide on a case/normalization-insensitive FS. A
/// fresh pull must materialize BOTH (winner on the canonical name, loser as a
/// deterministic conflict copy), never collapse to one file losing a note.
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn f4_same_filename_two_clients_no_note_lost() {
    if common::skip_if_no_server("f4_same_filename_two_clients_no_note_lost") {
        return;
    }
    let server = common::server_url().unwrap();
    // Case-variant collision in the BASE NAME (the `.md` extension stays
    // lowercase — the push path only recognizes a lowercase `.md` suffix). The
    // collision_key folds case, so the detector fires even on a case-SENSITIVE
    // CI filesystem.
    let base = common::unique("f4dup");
    let name_lower = format!("{}.md", base.to_lowercase());
    let name_upper = format!("{}.md", base.to_uppercase());
    assert_ne!(name_lower, name_upper, "base must differ by case");

    // Two independent clients each POST a distinct object at a colliding name.
    let (a, va) = fresh_client(&server).await;
    std::fs::write(va.join(&name_lower), "AAA from client A\n").unwrap();
    let (_c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push");

    let (b, vb) = fresh_client(&server).await;
    std::fs::write(vb.join(&name_upper), "BBB from client B\n").unwrap();
    let (_c, _b) = futo_notes_sync::run_push(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B push");

    // A fresh client pulls both. Neither note may be lost.
    let (c, vc) = fresh_client(&server).await;
    let _c = futo_notes_sync::run_sync(&c, &vc, &no_progress, &no_pre_write)
        .await
        .expect("C reconcile");

    // Collect every .md/.MD file's content under vc.
    let contents: Vec<String> = std::fs::read_dir(&vc)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_lowercase();
            n.ends_with(".md")
        })
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .collect();
    let has_a = contents.iter().any(|c| c.contains("AAA from client A"));
    let has_b = contents.iter().any(|c| c.contains("BBB from client B"));
    assert!(
        has_a && has_b,
        "F4: a colliding-name note was lost on fresh pull; files = {contents:?}"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
    common::cleanup(&vc);
}

/// F4 incremental-pull scope hole: a client that ALREADY holds the collision
/// winner on disk + in its object_map pulls ONLY the newly-created rival (the
/// winner is not in this incremental batch). The detector must rank the rival
/// against the persisted map, so the freshly-pulled note is parked at a
/// conflict copy instead of clobbering the on-disk winner. The pre-fix code
/// ranked only the current batch, so a same-key rival with no in-batch
/// opponent was written as canonical, overwriting the on-disk winner.
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn f4_incremental_pull_rival_does_not_clobber_on_disk_winner() {
    if common::skip_if_no_server("f4_incremental_pull_rival_does_not_clobber_on_disk_winner") {
        return;
    }
    let server = common::server_url().unwrap();
    let base = common::unique("f4inc");
    let lower = format!("{}.md", base.to_lowercase());
    let upper = format!("{}.md", base.to_uppercase());

    // Client A creates the (eventual) winner and pushes it.
    let (a, va) = fresh_client(&server).await;
    std::fs::write(va.join(&lower), "WINNER content\n").unwrap();
    let (_c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push winner");

    // Client C syncs and now holds the winner on disk + in its map.
    let (c, vc) = fresh_client(&server).await;
    let c = futo_notes_sync::run_sync(&c, &vc, &no_progress, &no_pre_write)
        .await
        .expect("C initial sync")
        .1;

    // A peer (B) creates a DISTINCT object at the colliding name.
    let (b, vb) = fresh_client(&server).await;
    std::fs::write(vb.join(&upper), "RIVAL content\n").unwrap();
    let (_c, _b) = futo_notes_sync::run_push(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B push rival");

    // C does an INCREMENTAL pull (its cursor only picks up the rival). The
    // rival must be parked; the on-disk winner must survive intact.
    let _c2 = futo_notes_sync::run_sync(&c, &vc, &no_progress, &no_pre_write)
        .await
        .expect("C incremental sync");

    let contents: Vec<String> = std::fs::read_dir(&vc)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().to_lowercase().ends_with(".md"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .collect();
    let has_winner = contents.iter().any(|c| c.contains("WINNER content"));
    let has_rival = contents.iter().any(|c| c.contains("RIVAL content"));
    assert!(
        has_winner && has_rival,
        "F4 incremental: on-disk winner clobbered by pulled rival; files = {contents:?}"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
    common::cleanup(&vc);
}

/// F5: NFC vs NFD spellings of the same accented filename are two DISTINCT
/// server objects that collapse to one entry on APFS. A fresh pull must
/// materialize both, never lose one note's content.
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn f5_nfc_nfd_collision_no_note_lost() {
    if common::skip_if_no_server("f5_nfc_nfd_collision_no_note_lost") {
        return;
    }
    let server = common::server_url().unwrap();
    let tag = common::unique("caf");
    // Composed é (NFC) vs decomposed e + U+0301 (NFD) — same display, distinct
    // bytes, same collision_key.
    let nfc = format!("{tag}-caf\u{00E9}.md");
    let nfd = format!("{tag}-cafe\u{0301}.md");
    assert_ne!(nfc, nfd);

    let (a, va) = fresh_client(&server).await;
    std::fs::write(va.join(&nfc), "NFC content alpha\n").unwrap();
    let (_c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push NFC");

    let (b, vb) = fresh_client(&server).await;
    std::fs::write(vb.join(&nfd), "NFD content beta\n").unwrap();
    let (_c, _b) = futo_notes_sync::run_push(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B push NFD");

    let (c, vc) = fresh_client(&server).await;
    let _c = futo_notes_sync::run_sync(&c, &vc, &no_progress, &no_pre_write)
        .await
        .expect("C reconcile");

    let contents: Vec<String> = std::fs::read_dir(&vc)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".md"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .collect();
    let has_alpha = contents.iter().any(|c| c.contains("NFC content alpha"));
    let has_beta = contents.iter().any(|c| c.contains("NFD content beta"));
    assert!(
        has_alpha && has_beta,
        "F5: an NFC/NFD-colliding note was lost on fresh pull; files = {contents:?}"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
    common::cleanup(&vc);
}

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
    assert!(s1.conflicts >= 1, "an oversize note must surface (conflict count)");
    assert!(a.oversize_skip.contains_key(&file), "oversize note must be marked");

    // A fresh peer must NOT receive it (it never reached the server).
    let vb = common::temp_vault();
    let (b, _i) = futo_notes_sync::connect(&vb, &server, common::TEST_PASSWORD)
        .await
        .expect("B connect");
    let b = pull(&b, &vb).await;
    assert!(!vb.join(&file).exists(), "peer must not receive an oversize note");

    // Push again with the unchanged file: pre-flight skip (no re-upload),
    // still surfaced, mark persists across cycles.
    let (s2, a) = futo_notes_sync::run_push(&a, &vault, &no_progress, &no_pre_write)
        .await
        .expect("push 2");
    assert_eq!(s2.uploaded, 0, "must still not upload on retry");
    assert!(s2.conflicts >= 1, "must still surface on retry");
    assert!(a.oversize_skip.contains_key(&file), "mark persists across cycles");

    // Shrink the note (new content + mtime) → recovers: uploads, clears mark,
    // peer receives it. The 10ms gap guarantees a fresh mtime so the
    // mtime-keyed skip releases (defensive against coarse fs mtime resolution).
    std::thread::sleep(std::time::Duration::from_millis(10));
    std::fs::write(vault.join(&file), "small now\n").unwrap();
    let (s3, a) = futo_notes_sync::run_push(&a, &vault, &no_progress, &no_pre_write)
        .await
        .expect("push 3");
    assert_eq!(s3.uploaded, 1, "a shrunk note uploads");
    assert!(!a.oversize_skip.contains_key(&file), "mark clears once it syncs");

    let _b = pull(&b, &vb).await;
    assert_eq!(
        std::fs::read_to_string(vb.join(&file)).unwrap(),
        "small now\n",
        "peer receives the note once it fits"
    );

    common::cleanup(&vault);
    common::cleanup(&vb);
}

// ── Disconnect → reconnect conflict-spam regressions ─────────────────────
//
// July 2026 incident: a device that disconnected (deleting `.e2ee-state.json`)
// and reconnected days later ran the empty-map reconcile with no ancestry, so
// F6 parked a `name (conflict <oid8>).md` copy of every note that had drifted
// meanwhile — even when the device's local file was bit-for-bit what it last
// synced (never edited on that device). Disconnect now demotes the state to
// `.e2ee-ancestry.json`, and the reconcile uses it to fast-forward instead.

/// Conflict copies minted for `file` ("name.md" → "name (conflict …).md")
/// present in `vault`. Scoped to the file's own stem because the integration
/// server's collection is shared across tests.
fn conflict_copies_of(vault: &Path, file: &str) -> Vec<String> {
    let stem = file.strip_suffix(".md").unwrap_or(file);
    let prefix = format!("{stem} (conflict");
    std::fs::read_dir(vault)
        .expect("read vault dir")
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| name.starts_with(&prefix))
        .collect()
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn reconnect_after_remote_drift_fast_forwards_instead_of_parking() {
    if common::skip_if_no_server("reconnect_after_remote_drift_fast_forwards_instead_of_parking") {
        return;
    }
    let server = common::server_url().unwrap();

    // A creates + pushes v1, then disconnects (what the shells' disconnect
    // and the desktop's e2ee_disconnect do to the persisted state).
    let (a, va) = fresh_client(&server).await;
    let file = format!("{}.md", common::unique("drift-clean"));
    std::fs::write(va.join(&file), "v1 from A\n").unwrap();
    let (_c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push v1");
    futo_notes_sync::state::demote_state_to_ancestry(&va).expect("disconnect A");

    // B edits the note to v2 while A is disconnected.
    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    std::fs::write(vb.join(&file), "v2 from B\n").unwrap();
    let (_c, _b) = futo_notes_sync::run_push(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B push v2");

    // A reconnects (fresh login, no live state) and syncs.
    let (a2, _info) = futo_notes_sync::connect(&va, &server, common::TEST_PASSWORD)
        .await
        .expect("A reconnect");
    assert!(a2.object_map.is_empty(), "reconnect after disconnect starts with an empty map");
    let (_summary, _a3) = futo_notes_sync::run_sync(&a2, &va, &no_progress, &no_pre_write)
        .await
        .expect("A reconcile sync");

    assert_eq!(
        std::fs::read_to_string(va.join(&file)).unwrap(),
        "v2 from B\n",
        "a stale-but-clean local file must fast-forward to the remote content"
    );
    assert_eq!(
        conflict_copies_of(&va, &file),
        Vec::<String>::new(),
        "a file this device never edited must NOT be parked as a conflict copy \
         just because it drifted while disconnected"
    );

    common::cleanup(&va);
    common::cleanup(&vb);
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn reconnect_after_local_edit_updates_same_object_instead_of_parking() {
    if common::skip_if_no_server("reconnect_after_local_edit_updates_same_object_instead_of_parking")
    {
        return;
    }
    let server = common::server_url().unwrap();

    // A creates + pushes v1, disconnects, then edits the note LOCALLY while
    // disconnected (remote untouched).
    let (a, va) = fresh_client(&server).await;
    let file = format!("{}.md", common::unique("drift-edited"));
    std::fs::write(va.join(&file), "v1 from A\n").unwrap();
    let (_c, a1) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push v1");
    let object_id = a1.object_map.get(&file).expect("mapped after push").object_id.clone();
    futo_notes_sync::state::demote_state_to_ancestry(&va).expect("disconnect A");
    std::fs::write(va.join(&file), "v2 edited offline on A\n").unwrap();

    // A reconnects and syncs: the local edit must survive and reach the
    // server as an UPDATE to the same object — no conflict copy, no
    // duplicate object.
    let (a2, _info) = futo_notes_sync::connect(&va, &server, common::TEST_PASSWORD)
        .await
        .expect("A reconnect");
    let (_summary, a3) = futo_notes_sync::run_sync(&a2, &va, &no_progress, &no_pre_write)
        .await
        .expect("A reconcile sync");

    assert_eq!(
        std::fs::read_to_string(va.join(&file)).unwrap(),
        "v2 edited offline on A\n",
        "an edit made while disconnected must survive the reconnect"
    );
    assert_eq!(
        conflict_copies_of(&va, &file),
        Vec::<String>::new(),
        "an offline edit against an unchanged remote is not a conflict"
    );
    assert_eq!(
        a3.object_map.get(&file).expect("still mapped").object_id,
        object_id,
        "the offline edit must update the SAME server object, not mint a duplicate"
    );

    // A fresh client sees the edited content — the update really pushed.
    let (c, vc) = fresh_client(&server).await;
    let _c = pull(&c, &vc).await;
    assert_eq!(
        std::fs::read_to_string(vc.join(&file)).unwrap(),
        "v2 edited offline on A\n",
        "peers receive the offline edit after the reconnect sync"
    );

    common::cleanup(&va);
    common::cleanup(&vc);
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn reconnect_after_remote_rename_deletes_stale_old_path_no_duplicate() {
    if common::skip_if_no_server(
        "reconnect_after_remote_rename_deletes_stale_old_path_no_duplicate",
    ) {
        return;
    }
    let server = common::server_url().unwrap();

    // A creates + pushes a note at the root, then disconnects and keeps that
    // old local path on disk.
    let (a, va) = fresh_client(&server).await;
    let stem = common::unique("drift-renamed");
    let root_file = format!("{stem}.md");
    let moved_file = format!("Folder/{stem}.md");
    std::fs::write(va.join(&root_file), "v1 before rename\n").unwrap();
    let (_c, a1) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push v1");
    let object_id = a1
        .object_map
        .get(&root_file)
        .expect("mapped after push")
        .object_id
        .clone();
    futo_notes_sync::state::demote_state_to_ancestry(&va).expect("disconnect A");

    // B renames the same object while A is disconnected.
    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    std::fs::remove_file(vb.join(&root_file)).unwrap();
    std::fs::create_dir_all(vb.join("Folder")).unwrap();
    std::fs::write(vb.join(&moved_file), "v1 before rename\n").unwrap();
    let (_c, _b) = futo_notes_sync::run_push(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B push rename");

    // A reconnects with an empty live map. The reconcile must use ancestry by
    // object_id to recognize that its stale root path is the pre-rename copy,
    // delete it locally, and map the moved filename to the SAME object. If the
    // old path survives, the push phase posts it as a duplicate new object.
    let (a2, _info) = futo_notes_sync::connect(&va, &server, common::TEST_PASSWORD)
        .await
        .expect("A reconnect");
    assert!(a2.object_map.is_empty(), "reconnect after disconnect starts empty");
    let (_summary, a3) = futo_notes_sync::run_sync(&a2, &va, &no_progress, &no_pre_write)
        .await
        .expect("A reconcile sync");

    assert!(!va.join(&root_file).exists(), "stale pre-rename path must be deleted");
    assert_eq!(
        std::fs::read_to_string(va.join(&moved_file)).unwrap(),
        "v1 before rename\n",
        "A must adopt the peer's renamed path"
    );
    assert!(!a3.object_map.contains_key(&root_file));
    assert_eq!(
        a3.object_map
            .get(&moved_file)
            .expect("moved path mapped")
            .object_id,
        object_id,
        "remote rename must keep tracking the same server object"
    );

    // A fresh peer should see only the moved path, not a duplicate re-upload of
    // A's stale root path.
    let (c, vc) = fresh_client(&server).await;
    let _c = pull(&c, &vc).await;
    assert!(vc.join(&moved_file).exists(), "fresh peer should receive moved note");
    assert!(
        !vc.join(&root_file).exists(),
        "stale root path must not be re-uploaded as a duplicate object"
    );

    common::cleanup(&va);
    common::cleanup(&vb);
    common::cleanup(&vc);
}

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
    let (push_summary, _a) =
        futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
            .await
            .expect("seed push");
    assert_eq!(push_summary.uploaded as usize, n, "all seed notes must upload");
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
    assert!(summary.failures.is_empty(), "no failures expected: {:?}", summary.failures);
    println!(
        "first sync of {} objects: connect {:?} + sync {:?} (downloaded {})",
        summary.downloaded, connect_elapsed, sync_elapsed, summary.downloaded
    );

    common::cleanup(&va);
    common::cleanup(&vb);
}
