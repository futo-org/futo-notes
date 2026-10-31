use super::*;
use futo_notes_editor::{PortableSession, SessionToken};

#[test]
fn withheld_due_flush_ack_preserves_marking_until_the_same_complete_update_is_retried() {
    use futo_notes_editor::{DisplayUtf16Offset, DisplayUtf16Range, PortableError};
    use std::sync::atomic::{AtomicU64, Ordering};
    struct Clock(AtomicU64);
    impl RecoveryClock for Clock {
        fn now(&self) -> Duration {
            Duration::from_millis(self.0.load(Ordering::SeqCst))
        }
    }
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "a").unwrap();
    let clock = Arc::new(Clock(AtomicU64::new(0)));
    let mut host = store
        .open_editor_with_recovery(
            "plain",
            RecoveryOptions {
                clock: clock.clone(),
                ..RecoveryOptions::default()
            },
        )
        .unwrap()
        .into_portable_host(SessionToken(133))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let input = page.replace(Revision(0), range(1, 1), "!").unwrap();
    let change = page.acknowledge(host.handle(input)).unwrap().unwrap();
    let mut view = "a".to_owned();
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    let marked_range = DisplayUtf16Range {
        start: DisplayUtf16Offset(2),
        end: DisplayUtf16Offset(2),
    };
    let first = "に".encode_utf16().collect::<Vec<_>>();
    let marked = page
        .compose_utf16(Revision(1), marked_range, &first)
        .unwrap();
    clock.0.store(100, Ordering::SeqCst);
    assert_eq!(host.recovery_flush_delay(), Some(Duration::ZERO));
    let flush = page.flush().unwrap();
    let withheld = std::thread::scope(|scope| scope.spawn(|| host.handle(flush)).join().unwrap());
    assert!(withheld.error.is_none(), "{withheld:?}");
    assert_eq!(withheld.durable, Revision(1));
    // Retain this exact callback payload while Flush owns the page request.
    let retained = "日本".encode_utf16().collect::<Vec<_>>();
    assert_eq!(
        page.compose_utf16(Revision(1), marked_range, &retained),
        Err(PortableError::Busy)
    );
    assert_eq!(page.composition(), Some(&marked));
    assert_eq!(page.draft_text(), "a!");
    assert_eq!(view, "a!");
    assert_eq!(page.status().durable, Revision(0));
    assert!(page.acknowledge(withheld.clone()).unwrap().is_none());
    assert!(page.acknowledge(withheld).unwrap().is_none());
    assert_eq!(page.status().durable, Revision(1));
    let updated = page
        .compose_utf16(Revision(1), marked_range, &retained)
        .unwrap();
    assert_eq!(updated.text, "日本");
    let commit = page
        .commit_composition_utf16(Revision(1), None)
        .unwrap()
        .unwrap();
    let accepted = host.handle(commit.clone());
    assert_eq!(host.handle(commit), accepted);
    assert_eq!(view, "a!");
    let change = page.acknowledge(accepted.clone()).unwrap().unwrap();
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    assert!(page.acknowledge(accepted).unwrap().is_none());
    assert!(page
        .commit_composition_utf16(Revision(2), None)
        .unwrap()
        .is_none());
    assert_eq!(view, "a!日本");
    assert_eq!(page.draft_text(), "a!日本");
    assert_eq!(page.status().accepted, Revision(2));
    assert!(page.composition().is_none());
    drop(host);
    assert_eq!(store.open_editor("plain").unwrap().source_text(), "a!日本");
}
