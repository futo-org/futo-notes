//! Raw HTTP blob lifecycle, modified-time convergence and the error contract.

use super::*;

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
