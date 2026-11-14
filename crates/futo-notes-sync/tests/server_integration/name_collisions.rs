//! F4/F5 regressions: two notes that want one filename both survive.

use super::*;

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
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .to_lowercase()
                .ends_with(".md")
        })
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

/// #251: independent offline creations with exactly the same name survive on BOTH
/// original clients, including repeated push/pull after conflict placement.
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn same_name_offline_creations_preserve_both_bodies_on_both_clients() {
    let server = common::server_url().expect("requires FUTO_TEST_SERVER");
    let (mut a, va) = fresh_client(&server).await;
    let (mut b, vb) = fresh_client(&server).await;
    let tag = common::unique("same-name");
    let name = format!("{tag}.md");
    let bodies = [
        format!("{tag} iOS original body\n"),
        format!("{tag} Milkdown original body\n"),
    ];
    std::fs::write(va.join(&name), &bodies[0]).unwrap();
    std::fs::write(vb.join(&name), &bodies[1]).unwrap();
    for _ in 0..3 {
        a = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
            .await
            .unwrap()
            .1;
        b = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
            .await
            .unwrap()
            .1;
    }
    for vault in [&va, &vb] {
        let mut actual: Vec<_> = std::fs::read_dir(vault)
            .unwrap()
            .map(Result::unwrap)
            .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
            .map(|e| std::fs::read_to_string(e.path()).unwrap())
            .filter(|body| body.starts_with(&tag))
            .collect();
        let mut expected = bodies.to_vec();
        actual.sort();
        expected.sort();
        assert_eq!(
            actual, expected,
            "both independent creations must survive exactly once"
        );
    }
    common::cleanup(&va);
    common::cleanup(&vb);
}

/// #124: filesystem aliases remain two independent bodies through bootstrap,
/// incremental pulls and later edits of either colliding object.
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn unicode_alias_pull_preserves_both_bodies() {
    fn assert_bodies(vault: &Path, tag: &str, expected: [&str; 2]) {
        let mut actual: Vec<_> = std::fs::read_dir(vault)
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "md")
            })
            .map(|entry| std::fs::read_to_string(entry.path()).unwrap())
            .filter(|body| body.starts_with(tag))
            .collect();
        let mut expected: Vec<_> = expected.into_iter().map(str::to_owned).collect();
        actual.sort();
        expected.sort();
        assert_eq!(
            actual,
            expected,
            "Unicode collision bodies in {}",
            vault.display()
        );
    }

    fn edit_body(vault: &Path, before: &str, after: &str) {
        let paths: Vec<_> = std::fs::read_dir(vault)
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "md")
            })
            .filter(|entry| std::fs::read_to_string(entry.path()).unwrap() == before)
            .map(|entry| entry.path())
            .collect();
        assert_eq!(paths.len(), 1, "exactly one editable copy of {before:?}");
        std::fs::write(&paths[0], after).unwrap();
    }

    let server = common::server_url().expect("requires FUTO_TEST_SERVER");
    for (left, right) in [
        ("\u{017f}", "s"),
        ("\u{00df}", "ss"),
        ("\u{fb01}", "fi"),
        ("\u{03a3}", "\u{03c3}"),
        ("\u{03c2}", "\u{03c3}"),
    ] {
        let tag = common::unique("unicode-alias");
        let local = format!("{tag} local Unicode body\n");
        let peer = format!("{tag} peer Unicode body\n");
        let (mut a, va) = fresh_client(&server).await;
        let (mut b, vb) = fresh_client(&server).await;
        std::fs::write(va.join(format!("{tag}-{left}.md")), &local).unwrap();
        std::fs::write(vb.join(format!("{tag}-{right}.md")), &peer).unwrap();
        a = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
            .await
            .unwrap()
            .1;
        b = futo_notes_sync::run_push(&b, &vb, &no_progress, &no_pre_write)
            .await
            .unwrap()
            .1;
        let (mut c, vc) = fresh_client(&server).await;
        c = futo_notes_sync::run_sync(&c, &vc, &no_progress, &no_pre_write)
            .await
            .unwrap()
            .1;
        for _ in 0..3 {
            a = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
                .await
                .unwrap()
                .1;
            b = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
                .await
                .unwrap()
                .1;
        }
        for vault in [&va, &vb, &vc] {
            assert_bodies(vault, &tag, [&local, &peer]);
        }

        let local_edit = format!("{tag} local Unicode body edited on A\n");
        edit_body(&va, &local, &local_edit);
        a = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
            .await
            .unwrap()
            .1;
        b = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
            .await
            .unwrap()
            .1;
        c = futo_notes_sync::run_sync(&c, &vc, &no_progress, &no_pre_write)
            .await
            .unwrap()
            .1;
        for vault in [&va, &vb, &vc] {
            assert_bodies(vault, &tag, [&local_edit, &peer]);
        }

        let peer_edit = format!("{tag} peer Unicode body edited on B\n");
        edit_body(&vb, &peer, &peer_edit);
        _ = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
            .await
            .unwrap()
            .1;
        _ = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
            .await
            .unwrap()
            .1;
        _ = futo_notes_sync::run_sync(&c, &vc, &no_progress, &no_pre_write)
            .await
            .unwrap()
            .1;
        for vault in [&va, &vb, &vc] {
            assert_bodies(vault, &tag, [&local_edit, &peer_edit]);
        }
        common::cleanup(&va);
        common::cleanup(&vb);
        common::cleanup(&vc);
    }
}
