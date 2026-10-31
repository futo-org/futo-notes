mod common;

use futo_notes_editor::{
    Affinity, DisplayOffset, DisplayRange, PortableError, PortableSession, Revision, SessionToken,
};

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
    assert_eq!(
        session.replace(Revision(0), DisplayRange::default(), "?"),
        Err(PortableError::Busy)
    );
    assert_eq!(
        session.select_with_affinity(Revision(0), DisplayRange::default(), Affinity::Forward),
        Err(PortableError::Busy)
    );
    assert_eq!(
        session.project(Revision(0), DisplayRange::default()),
        Err(PortableError::Busy)
    );
    assert_eq!(session.draft_text(), "plain!");
    let ack = request.accepted(Revision(1), Revision(0));
    view.apply(session.acknowledge(ack.clone()).unwrap().unwrap());
    assert_eq!(view.text, "plain!");
    assert_eq!(session.status().accepted, Revision(1));
    assert_eq!(session.status().durable, Revision(0));
    assert!(session.acknowledge(ack).unwrap().is_none());
    session
        .select_with_affinity(Revision(1), DisplayRange::default(), Affinity::Forward)
        .unwrap();
    assert!(session
        .project(Revision(1), DisplayRange::default())
        .is_ok());
    assert!(session
        .replace(Revision(1), DisplayRange::default(), "?")
        .is_ok());
}

#[test]
fn invalid_matching_ack_cannot_claim_protection_or_discard_the_pending_edit() {
    let mut page = PortableSession::open(SessionToken(8), "a", Revision(0), Revision(0));
    let request = page
        .replace(Revision(0), DisplayRange::default(), "!")
        .unwrap();
    let invalid = request.accepted(Revision(0), Revision(0));
    assert!(page.acknowledge(invalid).is_err());
    assert!(page
        .acknowledge(request.accepted(Revision(1), Revision(2)))
        .is_err());
    let mut stale_session = request.accepted(Revision(1), Revision(0));
    stale_session.token = SessionToken(7);
    assert!(page.acknowledge(stale_session).unwrap().is_none());
    assert_eq!(page.status().accepted, Revision(0));
    assert_eq!(page.status().durable, Revision(0));
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

#[test]
fn inline_projection_affinity_and_toggles_cross_the_portable_acceptance_boundary() {
    use futo_notes_editor::{Affinity, InlineFormat};
    let mut page = PortableSession::open(SessionToken(13), "__😀__*日*", Revision(0), Revision(0));
    let all = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(7),
    };
    assert_eq!(page.project(Revision(0), all).unwrap().text, "😀日");
    page.select_with_affinity(Revision(0), all, Affinity::Forward)
        .unwrap();
    let request = page
        .toggle_format(Revision(0), InlineFormat::Strike)
        .unwrap()
        .unwrap();
    assert_eq!(page.draft_text(), "~~__😀__*日*~~");
    assert!(
        page.project(Revision(1), all).is_err(),
        "pending projection cannot overtake displayed revision"
    );
    let change = page
        .acknowledge(request.accepted(Revision(1), Revision(0)))
        .unwrap()
        .unwrap();
    let wire = serde_json::to_string(&change).unwrap();
    let decoded: futo_notes_editor::ViewChange = serde_json::from_str(&wire).unwrap();
    assert_eq!(decoded, change);
    assert_eq!(change.affinity, Affinity::Forward);
    assert_eq!(change.projection.text, "😀日");
    assert_eq!(
        page.project(Revision(1), all).unwrap().runs[0].formats,
        vec![InlineFormat::Bold, InlineFormat::Strike]
    );
}

#[test]
fn portable_collapsed_formatting_carries_without_a_source_record() {
    use futo_notes_editor::{Affinity, InlineFormat};
    let mut page = PortableSession::open(SessionToken(14), "**a**_b_", Revision(0), Revision(0));
    let boundary = DisplayRange {
        start: DisplayOffset(1),
        end: DisplayOffset(1),
    };
    page.select_with_affinity(Revision(0), boundary, Affinity::Forward)
        .unwrap();
    assert_eq!(page.active_formats().unwrap(), vec![InlineFormat::Italic]);
    assert!(page
        .toggle_format(Revision(0), InlineFormat::Strike)
        .unwrap()
        .is_none());
    assert!(!page.status().waiting);
    assert_eq!(
        page.active_formats().unwrap(),
        vec![InlineFormat::Italic, InlineFormat::Strike]
    );
    let request = page.replace(Revision(0), boundary, "日").unwrap();
    assert_eq!(page.draft_text(), "**a**_~~日~~b_");
    let change = page
        .acknowledge(request.accepted(Revision(1), Revision(0)))
        .unwrap()
        .unwrap();
    assert_eq!(change.selection.start, DisplayOffset(4));
}

#[test]
fn paused_recovered_source_remains_available_as_a_rich_display_projection() {
    let page = PortableSession::from_snapshot(futo_notes_editor::HostSnapshot {
        token: SessionToken(15),
        source: "__copy me__".into(),
        revision: Revision(3),
        durable: Revision(1),
        paused: true,
    })
    .unwrap();
    let projection = page
        .project(
            Revision(3),
            DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(7),
            },
        )
        .unwrap();
    assert_eq!(projection.text, "copy me");
    assert_eq!(
        projection.runs[0].formats,
        vec![futo_notes_editor::InlineFormat::Bold]
    );
    assert!(page.status().paused);
}

#[test]
fn link_commands_wait_for_acceptance_and_return_canonical_semantics_with_exact_history() {
    let mut page = PortableSession::open(SessionToken(101), "__docs__", Revision(0), Revision(0));
    let mut view = common::ReferenceView::new("docs");
    let range = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(4),
    };
    let request = page
        .set_link(Revision(0), range, "https://x.test")
        .unwrap()
        .unwrap();
    assert_eq!(page.draft_text(), "[__docs__](<https://x.test>)");
    assert_eq!(view.text, "docs");
    assert!(page.inspect_link(Revision(1), range).is_err());
    view.apply(
        page.acknowledge(request.accepted(Revision(1), Revision(0)))
            .unwrap()
            .unwrap(),
    );
    let link = page.inspect_link(Revision(1), range).unwrap().unwrap();
    assert_eq!(link.destination, "https://x.test");
    assert_eq!(link.range, range);
    let undo = page.undo(Revision(1)).unwrap().unwrap();
    view.apply(
        page.acknowledge(undo.accepted(Revision(2), Revision(0)))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(page.draft_text(), "__docs__");
    assert_eq!(view.text, "docs");
    assert!(page.inspect_link(Revision(2), range).unwrap().is_none());
}
