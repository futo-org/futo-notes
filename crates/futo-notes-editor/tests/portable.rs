mod common;

use futo_notes_editor::{DisplayOffset, DisplayRange, PortableSession, Revision, SessionToken};

#[test]
fn page_local_edit_waits_for_host_acceptance_before_displaying_or_accepting_more_input() {
    let mut session = PortableSession::open(SessionToken(7), "plain", Revision(0), Revision(0));
    let mut view = common::ReferenceView::new("plain");
    let request = session
        .replace(
            Revision(0),
            DisplayRange {
                start: DisplayOffset(5),
                end: DisplayOffset(5),
            },
            "!",
        )
        .unwrap();
    assert_eq!(session.draft_text(), "plain!");
    assert_eq!(view.text, "plain");
    assert_eq!(session.status().accepted, Revision(0));
    assert!(session
        .replace(Revision(1), DisplayRange::default(), "?")
        .is_err());
    let ack = request.accepted(Revision(1), Revision(0));
    view.apply(session.acknowledge(ack.clone()).unwrap().unwrap());
    assert_eq!(view.text, "plain!");
    assert_eq!(session.status().accepted, Revision(1));
    assert_eq!(session.status().durable, Revision(0));
    assert!(session.acknowledge(ack).unwrap().is_none());
}

#[test]
fn invalid_matching_ack_cannot_claim_protection_or_discard_the_pending_edit() {
    let mut page = PortableSession::open(SessionToken(8), "a", Revision(0), Revision(0));
    let request = page
        .replace(Revision(0), DisplayRange::default(), "!")
        .unwrap();
    let invalid = request.accepted(Revision(0), Revision(0));
    assert!(page.acknowledge(invalid).is_err());
    assert!(page.status().waiting);
    assert_eq!(
        page.acknowledge(request.accepted(Revision(1), Revision(0)))
            .unwrap()
            .unwrap()
            .inserted,
        "!"
    );
}

#[test]
fn delayed_failed_ack_cannot_pause_a_resumed_session_or_release_a_delta_twice() {
    let mut page = PortableSession::open(SessionToken(9), "a", Revision(0), Revision(0));
    let request = page
        .replace(Revision(0), DisplayRange::default(), "!")
        .unwrap();
    let mut failed = request.accepted(Revision(0), Revision(0));
    failed.paused = true;
    failed.error = Some("append failed".into());
    assert!(page.acknowledge(failed.clone()).unwrap().is_none());
    assert_eq!(page.draft_text(), "!a");
    assert!(page.status().paused);
    let resume = page.resume().unwrap();
    page.acknowledge(resume.accepted(Revision(0), Revision(0)))
        .unwrap();
    let retry = page.retry_pending().unwrap();
    assert!(page.acknowledge(failed).unwrap().is_none());
    assert!(!page.status().paused);
    assert_eq!(
        page.acknowledge(retry.accepted(Revision(1), Revision(0)))
            .unwrap()
            .unwrap()
            .inserted,
        "!"
    );
}

#[test]
fn lost_append_reply_resumes_from_host_prefix_without_resending_the_edit() {
    let mut page = PortableSession::open(SessionToken(10), "a", Revision(0), Revision(0));
    let request = page
        .replace(Revision(0), DisplayRange::default(), "!")
        .unwrap();
    let resume = page.resume().unwrap();
    assert!(page
        .acknowledge(request.accepted(Revision(1), Revision(0)))
        .unwrap()
        .is_none());
    let change = page
        .acknowledge(resume.accepted(Revision(1), Revision(1)))
        .unwrap()
        .unwrap();
    assert_eq!(change.inserted, "!");
    assert_eq!(page.status().displayed, Revision(1));
    assert_eq!(page.status().durable, Revision(1));
}

#[test]
fn portable_native_utf16_input_rejects_surrogate_splits_before_staging_a_handoff() {
    use futo_notes_editor::{DisplayUtf16Offset, DisplayUtf16Range};
    let mut page = PortableSession::open(SessionToken(11), "a🎉b", Revision(0), Revision(0));
    let invalid = DisplayUtf16Range {
        start: DisplayUtf16Offset(2),
        end: DisplayUtf16Offset(2),
    };
    assert!(page
        .replace_utf16(Revision(0), invalid, &[b'!' as u16])
        .is_err());
    assert_eq!(page.draft_text(), "a🎉b");
    assert!(!page.status().waiting);
    let valid = DisplayUtf16Range {
        start: DisplayUtf16Offset(1),
        end: DisplayUtf16Offset(3),
    };
    let request = page
        .replace_utf16(Revision(0), valid, &[0x65, 0x301])
        .unwrap();
    assert_eq!(page.draft_text(), "ae\u{301}b");
    assert_eq!(
        page.acknowledge(request.accepted(Revision(1), Revision(0)))
            .unwrap()
            .unwrap()
            .inserted,
        "e\u{301}"
    );
}

#[test]
fn recovered_host_pause_is_preserved_when_a_page_attaches() {
    use futo_notes_editor::HostSnapshot;
    let mut page = PortableSession::from_snapshot(HostSnapshot {
        token: SessionToken(12),
        source: "copy me".into(),
        revision: Revision(3),
        durable: Revision(1),
        paused: true,
    })
    .unwrap();
    assert_eq!(page.draft_text(), "copy me");
    assert!(page.status().paused);
    assert!(page
        .replace(Revision(3), DisplayRange::default(), "!")
        .is_err());
    let resume = page.resume().unwrap();
    page.acknowledge(resume.accepted(Revision(3), Revision(3)))
        .unwrap();
    assert!(!page.status().paused);
}
