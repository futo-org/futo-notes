use super::*;
use futo_notes_editor::{PortableSession, SessionToken};
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn ordinary_native_recovery_pauses_open_portable_without_changing_the_protected_prefix() {
    for checkpoint in [false, true] {
        let root = TestRoot::new();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let store = store(&root);
        store.create("", "plain", "base").unwrap();
        let mut editor = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        editor.replace(Revision(0), range(4, 4), "!").unwrap();
        if checkpoint {
            editor.flush_recovery().unwrap();
            disk.lock().unwrap().fault = Some(storage::Fault::Retire);
            assert!(matches!(
                editor.checkpoint(),
                Err(EditorStoreError::CheckpointCommitted { .. })
            ));
        } else {
            disk.lock().unwrap().fault = Some(storage::Fault::Flush);
            assert!(matches!(
                editor.flush_recovery(),
                Err(EditorStoreError::RecoveryFlush(_))
            ));
        }
        let mut host = editor.into_portable_host(SessionToken(294)).unwrap();
        let opening = host.snapshot();
        assert_eq!(opening.source, "base!");
        assert_eq!(opening.revision, Revision(1));
        assert_eq!(opening.durable, Revision(u64::from(checkpoint)));
        assert!(opening.paused);
        let mut page = PortableSession::from_snapshot(opening).unwrap();
        disk.lock().unwrap().fault = None;
        if checkpoint {
            let pending = host.handle(page.resume().unwrap());
            assert!(pending.error.is_some());
            assert!(pending.paused);
            assert_eq!(pending.accepted, Revision(1));
            assert_eq!(pending.durable, Revision(1));
            assert!(page.acknowledge(pending).unwrap().is_none());
            host.checkpoint().unwrap();
        }
        let resumed = host.handle(page.resume().unwrap());
        assert!(resumed.error.is_none(), "{resumed:?}");
        assert!(!resumed.paused);
        assert_eq!(resumed.accepted, Revision(1));
        assert_eq!(resumed.durable, Revision(1));
        assert!(page.acknowledge(resumed).unwrap().is_none());
        assert_eq!(page.draft_text(), "base!");
        let request = page.replace(Revision(1), range(5, 5), "?").unwrap();
        assert!(page.acknowledge(host.handle(request)).unwrap().is_some());
        let flush = host.handle(page.flush().unwrap());
        assert_eq!(flush.durable, Revision(2));
        page.acknowledge(flush).unwrap();
        drop(host);
        disk.lock().unwrap().power_loss();
        assert_eq!(
            store
                .open_editor_with_recovery("plain", storage::options(&disk))
                .unwrap()
                .source_text(),
            "base!?"
        );
    }
}

#[test]
fn pending_native_adoption_cannot_advance_past_a_portable_opening_snapshot() {
    struct FailAfterRename(Arc<Mutex<storage::Disk>>);
    impl BeforeWrite for FailAfterRename {
        fn before_write(&self, changes: &[FileChange]) {
            if changes
                .iter()
                .any(|change| matches!(change, FileChange::Renamed { .. }))
            {
                self.0.lock().unwrap().fault = Some(storage::Fault::IdentityDecision);
            }
        }
    }
    let root = TestRoot::new();
    let disk = Arc::new(Mutex::new(storage::Disk::default()));
    let store =
        LocalNoteStore::with_before_write(root.0.clone(), Arc::new(FailAfterRename(disk.clone())));
    store.create("", "old", "[[old]]").unwrap();
    let mut editor = store
        .open_editor_with_recovery("old", storage::options(&disk))
        .unwrap();
    editor.replace(Revision(0), range(7, 7), "!").unwrap();
    editor.checkpoint().unwrap();
    let renamed = store.rename("old", "long name").unwrap();
    assert_eq!(renamed.final_id.as_deref(), Some("long name"));
    assert!(!renamed.warnings.is_empty());
    assert!(editor.recovery_status().paused);
    let mut host = match editor.into_portable_host(SessionToken(292)) {
        Ok(host) => host,
        Err(EditorStoreError::CheckpointPending) => {
            // A rejected conversion leaves the durable native intent available
            // for the normal public open/recovery workflow.
            disk.lock().unwrap().fault = None;
            store
                .open_editor_with_recovery("long name", storage::options(&disk))
                .unwrap()
                .into_portable_host(SessionToken(293))
                .unwrap()
        }
        Err(error) => panic!("unexpected conversion failure: {error:?}"),
    };
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    disk.lock().unwrap().fault = None;
    let resumed = host.handle(page.resume().unwrap());
    assert!(resumed.error.is_none(), "{resumed:?}");
    let result = page.acknowledge(resumed.clone());
    assert!(
        result.is_ok(),
        "pending native adoption passed the portable opening revision: {resumed:?}, {result:?}"
    );
    assert_eq!(page.draft_text(), "[[long name]]!");
    assert_eq!(host.snapshot().source, "[[long name]]!");
    // A pure adopted rewrite needs no recovery stream; reopening it starts a
    // fresh revision epoch. Drive the next input with the public page revision.
    let revision = page.status().local;
    let request = page.replace(revision, range(14, 14), "?").unwrap();
    assert!(page.acknowledge(host.handle(request)).unwrap().is_some());
    let flush = host.handle(page.flush().unwrap());
    assert_eq!(flush.durable, Revision(revision.0 + 1));
    page.acknowledge(flush).unwrap();
    drop(host);
    disk.lock().unwrap().power_loss();
    assert_eq!(
        store
            .open_editor_with_recovery("long name", storage::options(&disk))
            .unwrap()
            .source_text(),
        "[[long name]]!?"
    );
}

#[test]
fn portable_attachment_rejects_an_already_deleted_native_session() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    let editor = store.open_editor("old").unwrap();
    store.delete("old").unwrap();
    assert!(matches!(
        editor.into_portable_host(SessionToken(291)),
        Err(EditorStoreError::SessionDeleted)
    ));
    assert_eq!(store.read_existing("old").unwrap(), None);
}

#[test]
fn portable_attachment_cannot_open_before_a_prepared_native_relink_finishes() {
    struct RenameWindow {
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl BeforeWrite for RenameWindow {
        fn before_write(&self, changes: &[FileChange]) {
            if changes
                .iter()
                .any(|change| matches!(change, FileChange::Renamed { .. }))
            {
                let _ = self.entered.send(());
                let _ = self.release.lock().unwrap().recv();
            }
        }
    }
    let root = TestRoot::new();
    let (rename_entered, rename_wait) = mpsc::channel();
    let (rename_release, rename_continue) = mpsc::channel();
    let store = LocalNoteStore::with_before_write(
        root.0.clone(),
        Arc::new(RenameWindow {
            entered: rename_entered,
            release: Mutex::new(rename_continue),
        }),
    );
    store.create("", "old", "[[old]]").unwrap();
    let editor = store.open_editor("old").unwrap();
    let armed = Arc::new(AtomicBool::new(false));
    let (progress, receive) = mpsc::channel();
    *store.gate_wait_hook.lock().unwrap() = Some(Box::new({
        let armed = armed.clone();
        let progress = progress.clone();
        move || {
            if armed.swap(false, Ordering::SeqCst) {
                let _ = progress.send(());
            }
        }
    }));
    std::thread::scope(|scope| {
        let rename_release = rename_release;
        let renamed = scope.spawn(|| store.rename("old", "long name"));
        rename_wait.recv_timeout(Duration::from_secs(10)).unwrap();
        armed.store(true, Ordering::SeqCst);
        let attached = scope.spawn(move || {
            let host = editor.into_portable_host(SessionToken(290)).unwrap();
            let snapshot = host.snapshot();
            let _ = progress.send(());
            (host, snapshot)
        });
        // Release either an attachment waiting at the gate or one that already
        // returned an opening snapshot. No timeout selects the interleaving.
        receive.recv_timeout(Duration::from_secs(10)).unwrap();
        rename_release.send(()).unwrap();
        let result = renamed.join().unwrap().unwrap();
        assert!(result.warnings.is_empty(), "{result:?}");
        let (mut host, opening) = attached.join().unwrap();
        let mut page = PortableSession::from_snapshot(opening).unwrap();
        let ack = host.handle(page.flush().unwrap());
        assert_eq!(
            ack.accepted,
            page.status().accepted,
            "a prepared native relink must not advance past the portable opening snapshot: {ack:?}"
        );
        page.acknowledge(ack).unwrap();
        assert_eq!(page.draft_text(), "[[long name]]");
        assert_eq!(host.snapshot().source, "[[long name]]");
        let request = page.replace(Revision(1), range(13, 13), "!").unwrap();
        assert_eq!(
            page.acknowledge(host.handle(request))
                .unwrap()
                .unwrap()
                .inserted,
            "!"
        );
        let undo = page.undo(Revision(2)).unwrap().unwrap();
        page.acknowledge(host.handle(undo)).unwrap().unwrap();
        assert_eq!(page.draft_text(), "[[long name]]");
        let redo = page.redo(Revision(3)).unwrap().unwrap();
        page.acknowledge(host.handle(redo)).unwrap().unwrap();
        assert_eq!(page.draft_text(), "[[long name]]!");
    });
    assert_eq!(
        store.open_editor("long name").unwrap().source_text(),
        "[[long name]]!"
    );
}
