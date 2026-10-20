//! F1 push-first ordering and saves that land while an upload is in flight.

use super::*;

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

/// A forwarding proxy in front of the real server that runs `hook` just before
/// it forwards the nth write request (`PUT`/`POST` on a blob object, the batch
/// route excluded) — the one moment a sync cycle is between reading a local
/// file and writing its settled result back. `hook` is where a test lands the
/// editor's next debounced save, deterministically, in that window.
struct SaveDuringUpload {
    upstream: String,
    method: &'static str,
    nth: usize,
    seen: std::sync::atomic::AtomicUsize,
    hook: Box<dyn Fn() + Send + Sync>,
}

impl wiremock::Respond for SaveDuringUpload {
    fn respond(&self, request: &wiremock::Request) -> wiremock::ResponseTemplate {
        use std::io::{Read, Write};
        use std::sync::atomic::Ordering;

        let path = request.url.path();
        if request.method.as_str() == self.method
            && path.contains("/blob-objects")
            && !path.ends_with("/batch")
            && self.seen.fetch_add(1, Ordering::SeqCst) + 1 == self.nth
        {
            (self.hook)();
        }
        let target = match request.url.query() {
            Some(query) => format!("{path}?{query}"),
            None => path.to_owned(),
        };
        let mut head = format!(
            "{} {target} HTTP/1.0\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n",
            request.method,
            self.upstream,
            request.body.len()
        );
        for (name, value) in &request.headers {
            if matches!(
                name.as_str(),
                "host" | "connection" | "content-length" | "transfer-encoding"
            ) {
                continue;
            }
            head.push_str(&format!(
                "{name}: {}\r\n",
                value.to_str().unwrap_or_default()
            ));
        }
        head.push_str("\r\n");
        let mut stream = std::net::TcpStream::connect(&self.upstream).expect("reach the server");
        stream.write_all(head.as_bytes()).expect("forward head");
        stream.write_all(&request.body).expect("forward body");
        let mut raw = Vec::new();
        stream
            .read_to_end(&mut raw)
            .expect("read the server's answer");
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("response head");
        let response_head = String::from_utf8_lossy(&raw[..split]).to_string();
        let status: u16 = response_head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .expect("status");
        let content_type = response_head
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-type")
                    .then(|| value.trim().to_owned())
            })
            .unwrap_or_else(|| "application/octet-stream".to_owned());
        wiremock::ResponseTemplate::new(status)
            .set_body_raw(raw[split + 4..].to_vec(), &content_type)
    }
}

async fn save_during_upload(
    server: &str,
    method: &'static str,
    nth: usize,
    hook: impl Fn() + Send + Sync + 'static,
) -> wiremock::MockServer {
    let proxy = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::any())
        .respond_with(SaveDuringUpload {
            upstream: server
                .trim_start_matches("http://")
                .trim_end_matches('/')
                .to_owned(),
            method,
            nth,
            seen: std::sync::atomic::AtomicUsize::new(0),
            hook: Box::new(hook),
        })
        .mount(&proxy)
        .await;
    proxy
}

/// Every file of `vault` holding `needle`, by name.
fn files_containing(vault: &Path, needle: &str) -> Vec<String> {
    std::fs::read_dir(vault)
        .expect("read vault dir")
        .filter_map(|e| e.ok())
        .filter(|e| {
            std::fs::read_to_string(e.path())
                .map(|c| c.contains(needle))
                .unwrap_or(false)
        })
        .filter_map(|e| e.file_name().into_string().ok())
        .collect()
}

/// RC-82: B's first debounced save conflicts with A's pushed edit and merges
/// cleanly, and B's NEXT save lands while the merged revision is uploading, so
/// the merged text can no longer be written over B's file. B's file does not
/// hold A's edit; B's following cycle must not push it over the merged
/// revision as a plain update. On iOS this was a peer edit on an open note
/// vanishing with no conflict copy, ~1 run in 8 (Back after typing).
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn save_during_a_clean_merge_keeps_the_peer_edit() {
    if common::skip_if_no_server("save_during_a_clean_merge_keeps_the_peer_edit") {
        return;
    }
    let server = common::server_url().unwrap();
    let file = format!("{}.md", common::unique("rc82-merge"));

    let (a, va) = fresh_client(&server).await;
    std::fs::write(va.join(&file), "L1\nL2\nL3\nL4\nL5\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push base");
    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    std::fs::write(va.join(&file), "A1 peer\nL2\nL3\nL4\nL5\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push peer edit");

    // B's first save; the second lands during the merged upload (B's 2nd PUT).
    std::fs::write(vb.join(&file), "L1\nL2\nL3\nL4\nB5\n").unwrap();
    let saved = vb.join(&file);
    let fired = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let hook_fired = fired.clone();
    let proxy = save_during_upload(&server, "PUT", 2, move || {
        std::fs::write(&saved, "L1\nL2\nL3\nL4\nB5 typed on\n").unwrap();
        hook_fired.store(true, std::sync::atomic::Ordering::SeqCst);
    })
    .await;
    let mut proxied = b.clone();
    proxied.base_url = proxy.uri();
    let (_s, mut b) = futo_notes_sync::run_sync(&proxied, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B sync (merge)");
    assert!(
        fired.load(std::sync::atomic::Ordering::SeqCst),
        "the save never landed inside the upload window"
    );
    b.base_url = server.clone();
    let (_s, _b) = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B next sync");
    let (_s, _a) = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A pull");

    assert_eq!(
        std::fs::read_to_string(va.join(&file)).unwrap(),
        "A1 peer\nL2\nL3\nL4\nB5 typed on\n",
        "A's edit must survive B's save during the merge; A's vault: peer in {:?}",
        files_containing(&va, "A1 peer")
    );
    assert!(
        conflict_copies_of(&va, &file).is_empty(),
        "a clean merge mints no copy"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

/// RC-82, the conflict-copy arm: B's save conflicts with A's edit on the same
/// line, so B's text is parked in a conflict copy and A's revision is to take
/// the note — and B's next save lands while the copy is uploading. B's file
/// then holds neither A's text nor a descendant of it; pushing it as a plain
/// update over A's revision would leave A's edit nowhere.
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn save_during_a_conflict_copy_keeps_the_peer_edit() {
    if common::skip_if_no_server("save_during_a_conflict_copy_keeps_the_peer_edit") {
        return;
    }
    let server = common::server_url().unwrap();
    let file = format!("{}.md", common::unique("rc82-copy"));

    let (a, va) = fresh_client(&server).await;
    std::fs::write(va.join(&file), "L1\nL2\nL3\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push base");
    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    std::fs::write(va.join(&file), "L1\nA2 peer\nL3\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push peer edit");

    // B's first save; the second lands while the copy is created (B's 1st POST).
    std::fs::write(vb.join(&file), "L1\nB2\nL3\n").unwrap();
    let saved = vb.join(&file);
    let fired = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let hook_fired = fired.clone();
    let proxy = save_during_upload(&server, "POST", 1, move || {
        std::fs::write(&saved, "L1\nB2 typed on\nL3\n").unwrap();
        hook_fired.store(true, std::sync::atomic::Ordering::SeqCst);
    })
    .await;
    let mut proxied = b.clone();
    proxied.base_url = proxy.uri();
    let (_s, mut b) = futo_notes_sync::run_sync(&proxied, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B sync (conflict)");
    assert!(
        fired.load(std::sync::atomic::Ordering::SeqCst),
        "the save never landed inside the upload window"
    );
    b.base_url = server.clone();
    let (_s, _b) = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B next sync");
    let (_s, _a) = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A pull");

    assert!(
        !files_containing(&va, "A2 peer").is_empty(),
        "A's edit was overwritten by B's save during the conflict copy; A's note = {:?}",
        std::fs::read_to_string(va.join(&file)).unwrap_or_default()
    );
    assert!(
        !files_containing(&va, "B2 typed on").is_empty(),
        "B's latest save was lost"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

/// RC-93: a pull checks that B's note still holds the revision it recorded, then
/// replaces it with A's edit — and B's editor saves in between. The check and the
/// write must be one step under the vault guard the save also takes, or the pull
/// overwrites B's save with A's text. `pre_write` is the engine's own call just
/// before the pull writes the file, so the save is landed exactly there.
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn save_during_a_pull_write_is_not_overwritten() {
    if common::skip_if_no_server("save_during_a_pull_write_is_not_overwritten") {
        return;
    }
    let server = common::server_url().unwrap();
    let file = format!("{}.md", common::unique("rc93-pull"));

    let (a, va) = fresh_client(&server).await;
    std::fs::write(va.join(&file), "L1\nL2\nL3\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push base");
    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    std::fs::write(va.join(&file), "A1 peer\nL2\nL3\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push peer edit");

    // B's note is clean when the cycle starts; the save lands as the pull writes.
    let saved = vb.join(&file);
    let target = file.clone();
    let fired = std::sync::atomic::AtomicBool::new(false);
    let save_during_write = move |name: &str| {
        if name == target && !fired.swap(true, std::sync::atomic::Ordering::SeqCst) {
            std::fs::write(&saved, "L1\nL2\nB3 saved\n").unwrap();
        }
    };
    let (_s, b) = futo_notes_sync::run_sync(&b, &vb, &no_progress, &save_during_write)
        .await
        .expect("B sync (pull)");
    assert!(
        !files_containing(&vb, "B3 saved").is_empty(),
        "B's save was overwritten by the pull; B's note = {:?}",
        std::fs::read_to_string(vb.join(&file)).unwrap_or_default()
    );
    let (_s, _b) = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B next sync");
    let (_s, _a) = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A pull");

    assert_eq!(
        std::fs::read_to_string(va.join(&file)).unwrap(),
        "A1 peer\nL2\nB3 saved\n",
        "both edits merge once B's save is pushed"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}
