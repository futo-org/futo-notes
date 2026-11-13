use super::*;
use futo_notes_editor::{PortableSession, SessionToken};
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn native_relink_adoption_completes_before_a_portable_attachment() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "[[old]]").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(7, 7), "!").unwrap();
    editor.checkpoint().unwrap();
    let renamed = store.rename("old", "long name").unwrap();
    assert_eq!(renamed.final_id.as_deref(), Some("long name"));
    assert!(renamed.warnings.is_empty(), "{renamed:?}");
    let mut host = editor.into_portable_host(SessionToken(292)).unwrap();
    let opening = host.snapshot();
    assert_eq!(opening.source, "[[long name]]!");
    assert!(!opening.paused);
    let mut page = PortableSession::from_snapshot(opening).unwrap();
    let resumed = host.handle(page.resume().unwrap());
    assert!(resumed.error.is_none(), "{resumed:?}");
    page.acknowledge(resumed).unwrap();
    assert_eq!(page.draft_text(), "[[long name]]!");
    let revision = page.status().local;
    let request = page.replace(revision, range(14, 14), "?").unwrap().request;
    page.acknowledge(host.handle(request)).unwrap();
    assert_eq!(page.status().outstanding, 0);
    host.checkpoint().unwrap();
    drop(host);
    assert_eq!(store.read("long name").unwrap(), "[[long name]]!?");
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
        let ack = host.handle(page.resume().unwrap());
        assert_eq!(
            ack.accepted,
            page.status().accepted,
            "a prepared native relink must not advance past the portable opening snapshot: {ack:?}"
        );
        page.acknowledge(ack).unwrap();
        assert_eq!(page.draft_text(), "[[long name]]");
        assert_eq!(host.snapshot().source, "[[long name]]");
        let applied = page.replace(Revision(1), range(13, 13), "!").unwrap();
        assert_eq!(applied.change.inserted, "!");
        page.acknowledge(host.handle(applied.request)).unwrap();
        let undo = page.undo(Revision(2)).unwrap().unwrap();
        page.acknowledge(host.handle(undo.request)).unwrap();
        assert_eq!(page.draft_text(), "[[long name]]");
        let redo = page.redo(Revision(3)).unwrap().unwrap();
        page.acknowledge(host.handle(redo.request)).unwrap();
        assert_eq!(page.draft_text(), "[[long name]]!");
        host.checkpoint().unwrap();
    });
    assert_eq!(
        store.open_editor("long name").unwrap().source_text(),
        "[[long name]]!"
    );
}
