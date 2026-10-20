//! Connect, auth, collections and key material against a live dev-mode server.

use super::*;

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

/// The authenticate/unlock seam: the two verbs, called in that order, reach the
/// same vault key and the same session facts that `connect` reaches in one call.
/// Password mode composes them, so if this ever diverges the composition inside
/// `connect` has stopped matching its parts.
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn authenticate_then_unlock_matches_connect() {
    if common::skip_if_no_server("authenticate_then_unlock_matches_connect") {
        return;
    }
    let server = common::server_url().unwrap();
    let vault = common::temp_vault();
    let (connected, info) = futo_notes_sync::connect(&vault, &server, common::TEST_PASSWORD)
        .await
        .expect("connect");

    let session = futo_notes_sync::authenticate(&server, common::TEST_PASSWORD)
        .await
        .expect("authenticate");
    assert_eq!(session.user_id, info.user_id);
    assert_eq!(session.collection_id, info.collection_id);
    assert_eq!(session.auth_mode, info.auth_mode);
    assert!(!session.token.is_empty());

    let vault_key = futo_notes_sync::unlock_with_password(&session, common::TEST_PASSWORD)
        .await
        .expect("unlock");
    assert_eq!(vault_key, connected.vault_key);
    common::cleanup(&vault);
}

/// Regression for the canonical-vault invariant: two devices that set up sync
/// against the SAME fresh server *concurrently* must converge on ONE vault, not
/// fork into two. The server preserves plural collection rows for data safety,
/// so each racing connect may create a row. Clients must re-list and select the
/// same earliest row before claiming first-write-wins key material.
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
/// server, `resume()` surfaces `CollectionGone` (message prefixed
/// `collection-gone:`) — which the desktop catches to re-connect — and a fresh
/// `connect()` then lands on a live vault. (Native shells already self-heal:
/// they only ever connect().)
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn resume_after_vault_deleted_signals_collection_gone_then_reconnects() {
    if common::skip_if_no_server(
        "resume_after_vault_deleted_signals_collection_gone_then_reconnects",
    ) {
        return;
    }
    let server = common::server_url().unwrap();
    let va = common::temp_vault();

    let (_s, info) = futo_notes_sync::connect(&va, &server, common::TEST_PASSWORD)
        .await
        .expect("connect");

    // Delete the vault server-side to exercise a stale persisted collection id.
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
    assert!(
        !rmsg.contains("collection-gone"),
        "missing key is not collection-gone: {rmsg}"
    );
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
