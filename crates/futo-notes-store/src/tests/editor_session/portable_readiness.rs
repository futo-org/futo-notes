use super::*;
use futo_notes_editor::{PortableSession, SessionToken};

#[test]
fn queued_append_cannot_overtake_a_committed_pending_identity() {
    use std::sync::atomic::{AtomicBool, Ordering};
    struct RenameWindow {
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
        disk: Arc<Mutex<storage::Disk>>,
    }
    impl BeforeWrite for RenameWindow {
        fn before_write(&self, changes: &[FileChange]) {
            if changes
                .iter()
                .any(|change| matches!(change, FileChange::Renamed { .. }))
            {
                let _ = self.entered.send(());
                // Controller failure disconnects this channel and releases the
                // workflow before thread::scope joins its children.
                let _ = self.release.lock().unwrap().recv();
                self.disk.lock().unwrap().fault = Some(storage::Fault::IdentityDecision);
            }
        }
    }
    for (source, end, expected) in [("base", 4, "base!"), ("[[old]]", 7, "[[old]]!")] {
        let root = TestRoot::new();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let (rename_entered, rename_wait) = mpsc::channel();
        let (rename_release, rename_continue) = mpsc::channel();
        let store = LocalNoteStore::with_before_write(
            root.0.clone(),
            Arc::new(RenameWindow {
                entered: rename_entered,
                release: Mutex::new(rename_continue),
                disk: disk.clone(),
            }),
        );
        store.create("", "old", source).unwrap();
        let mut host = store
            .open_editor_with_recovery("old", storage::options(&disk))
            .unwrap()
            .into_portable_host(SessionToken(289))
            .unwrap();
        let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
        let request = page.replace(Revision(0), range(end, end), "!").unwrap();
        let armed = Arc::new(AtomicBool::new(false));
        let (gate_entered, gate_wait) = mpsc::channel();
        let (gate_release, gate_continue) = mpsc::channel();
        *store.gate_wait_hook.lock().unwrap() = Some(Box::new({
            let armed = armed.clone();
            let release = Mutex::new(gate_continue);
            move || {
                if armed.swap(false, Ordering::SeqCst) {
                    let _ = gate_entered.send(());
                    let _ = release.lock().unwrap().recv();
                }
            }
        }));
        std::thread::scope(|scope| {
            // These senders must be owned inside the scoped closure: unwinding it
            // disconnects both blocked workers before scope waits for their exit.
            let rename_release = rename_release;
            let gate_release = gate_release;
            let renamed = scope.spawn(|| store.rename("old", "new"));
            // Identity preparation has captured its accepted prefix, but the
            // attachment is still healthy while the rename holds the store gate.
            rename_wait.recv_timeout(Duration::from_secs(10)).unwrap();
            assert!(!host.snapshot().paused);
            armed.store(true, Ordering::SeqCst);
            let append = scope.spawn(move || {
                let ack = host.handle(request);
                (host, ack)
            });
            gate_wait.recv_timeout(Duration::from_secs(10)).unwrap();
            rename_release.send(()).unwrap();
            let result = renamed.join().unwrap().unwrap();
            assert_eq!(result.final_id.as_deref(), Some("new"));
            assert!(!result.warnings.is_empty());
            gate_release.send(()).unwrap();
            let (mut host, ack) = append.join().unwrap();
            assert_eq!(
                ack.accepted,
                Revision(0),
                "queued input must not overtake the captured identity prefix: {ack:?}"
            );
            assert!(ack.paused);
            assert!(ack.error.is_some());
            assert!(page.acknowledge(ack).unwrap().is_none());
            assert_eq!(page.draft_text(), expected);
            assert_eq!(page.status().displayed, Revision(0));
            disk.lock().unwrap().fault = None;
            let resume = host.handle(page.resume().unwrap());
            assert!(resume.error.is_none(), "{resume:?}");
            assert_eq!(resume.accepted, Revision(0));
            assert!(page.acknowledge(resume).unwrap().is_none());
            let retry = host.handle(page.retry_pending().unwrap());
            assert_eq!(retry.accepted, Revision(1));
            assert!(retry.error.is_none(), "{retry:?}");
            assert_eq!(page.acknowledge(retry).unwrap().unwrap().inserted, "!");
            let flush = host.handle(page.flush().unwrap());
            assert_eq!(flush.durable, Revision(1));
            page.acknowledge(flush).unwrap();
        });
        disk.lock().unwrap().power_loss();
        let reopened = store
            .open_editor_with_recovery("new", storage::options(&disk))
            .unwrap();
        assert_eq!(reopened.source_text(), expected);
        assert_eq!(reopened.revision(), Revision(1));
        assert_eq!(store.read_existing("old").unwrap(), None);
    }
}

#[test]
fn duplicate_append_reports_current_workflow_pause_without_losing_accepted_input() {
    struct FailAfterRename(Arc<Mutex<storage::Disk>>);
    impl BeforeWrite for FailAfterRename {
        fn before_write(&self, changes: &[FileChange]) {
            if changes
                .iter()
                .any(|change| matches!(change, FileChange::Renamed { .. }))
            {
                self.0.lock().unwrap().fault = Some(storage::Fault::Create);
            }
        }
    }
    for (workflow, final_id, reopened_revision) in
        [("identity", "new", 1), ("checkpoint", "old", 0)]
    {
        let root = TestRoot::new();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let store = LocalNoteStore::with_before_write(
            root.0.clone(),
            Arc::new(FailAfterRename(disk.clone())),
        );
        store.create("", "old", "base").unwrap();
        let mut host = store
            .open_editor_with_recovery("old", storage::options(&disk))
            .unwrap()
            .into_portable_host(SessionToken(288))
            .unwrap();
        let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
        let request = page.replace(Revision(0), range(4, 4), "!").unwrap();
        let lost_ack = host.handle(request.clone());
        assert_eq!(lost_ack.accepted, Revision(1));
        assert!(!lost_ack.paused);
        if workflow == "identity" {
            let renamed = store.rename("old", "new").unwrap();
            assert_eq!(renamed.final_id.as_deref(), Some("new"));
            assert!(!renamed.warnings.is_empty());
        } else {
            disk.lock().unwrap().fault = Some(storage::Fault::Retire);
            assert!(matches!(
                host.checkpoint(),
                Err(EditorStoreError::CheckpointCommitted { .. })
            ));
        }
        assert!(host.snapshot().paused);

        let duplicate = host.handle(request);
        assert!(
            duplicate.paused,
            "a cached acceptance must report the attachment's current pause: {duplicate:?}"
        );
        assert_eq!(duplicate.accepted, Revision(1));
        assert!(page.acknowledge(duplicate).unwrap().is_none());
        assert_eq!(page.status().displayed, Revision(0));
        assert_eq!(page.draft_text(), "base!");
        disk.lock().unwrap().fault = None;
        if workflow == "checkpoint" {
            host.checkpoint().unwrap();
        }
        let resumed = host.handle(page.resume().unwrap());
        assert!(resumed.error.is_none(), "{resumed:?}");
        assert_eq!(resumed.accepted, Revision(1));
        assert_eq!(resumed.durable, Revision(1));
        assert_eq!(page.acknowledge(resumed).unwrap().unwrap().inserted, "!");
        drop(host);
        disk.lock().unwrap().power_loss();
        let reopened = store
            .open_editor_with_recovery(final_id, storage::options(&disk))
            .unwrap();
        assert_eq!(reopened.source_text(), "base!");
        assert_eq!(reopened.revision(), Revision(reopened_revision));
    }
}
