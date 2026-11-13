mod common;

use futo_notes_editor::{
    Affinity, DisplayOffset, DisplayRange, HostError, HostErrorKind, HostOperation, PortableError,
    PortableSession, Revision, SessionToken,
};

fn at(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn an_edit_shows_at_once_and_acknowledgement_only_advances_accepted() {
    let mut session = PortableSession::open(SessionToken(7), "plain", Revision(0));
    let mut view = common::ReferenceView::new("plain");
    let applied = session.replace(Revision(0), at(5, 5), "!").unwrap();
    view.apply(applied.change.clone());
    assert_eq!(view.text, "plain!");
    assert_eq!(session.draft_text(), "plain!");
    assert_eq!(session.status().accepted, Revision(0));
    assert_eq!(session.status().outstanding, 1);
    let ack = applied.request.accepted(Revision(1));
    assert!(session.acknowledge(ack.clone()).unwrap().is_empty());
    assert_eq!(session.status().accepted, Revision(1));
    assert_eq!(session.status().outstanding, 0);
    assert!(session.acknowledge(ack).unwrap().is_empty());
}

#[test]
fn several_edits_can_be_outstanding_and_each_displays_immediately() {
    let mut page = PortableSession::open(SessionToken(70), "", Revision(0));
    let mut view = common::ReferenceView::new("");
    let mut requests = Vec::new();
    for (index, ch) in ["a", "b", "c"].into_iter().enumerate() {
        let applied = page
            .replace(Revision(index as u64), at(index, index), ch)
            .unwrap();
        view.apply(applied.change);
        requests.push(applied.request);
        assert_eq!(view.text, &"abc"[..=index]);
    }
    let sequences: Vec<u64> = requests.iter().map(|request| request.sequence).collect();
    assert_eq!(sequences, [1, 2, 3]);
    assert_eq!(page.status().outstanding, 3);
    // Queries, selection and composition never wait on acknowledgements.
    assert!(page.project(Revision(3), at(0, 3)).is_ok());
    page.select_with_affinity(Revision(3), at(1, 1), Affinity::Forward)
        .unwrap();
    assert!(page
        .compose_utf16(Revision(3), utf16(1, 1), &[b'x' as u16])
        .is_ok());
    page.cancel_composition(Revision(3)).unwrap();
    // One acknowledgement covers the edits it is for; later ones stay outstanding.
    page.acknowledge(requests[1].accepted(Revision(2))).unwrap();
    assert_eq!(page.status().accepted, Revision(2));
    assert_eq!(page.status().outstanding, 1);
    page.acknowledge(requests[2].accepted(Revision(3))).unwrap();
    assert_eq!(page.status().outstanding, 0);
}

fn utf16(start: usize, end: usize) -> futo_notes_editor::DisplayUtf16Range {
    use futo_notes_editor::DisplayUtf16Offset;
    futo_notes_editor::DisplayUtf16Range {
        start: DisplayUtf16Offset(start),
        end: DisplayUtf16Offset(end),
    }
}

#[test]
fn an_invalid_or_foreign_ack_changes_nothing() {
    let mut page = PortableSession::open(SessionToken(8), "a", Revision(0));
    let applied = page.replace(Revision(0), at(0, 0), "!").unwrap();
    // A success ack must report exactly the edit's resulting revision.
    assert!(page
        .acknowledge(applied.request.accepted(Revision(0)))
        .is_err());
    let mut foreign = applied.request.accepted(Revision(1));
    foreign.token = SessionToken(7);
    assert!(page.acknowledge(foreign).unwrap().is_empty());
    let mut unknown = applied.request.accepted(Revision(1));
    unknown.sequence = 99;
    assert!(page.acknowledge(unknown).unwrap().is_empty());
    assert_eq!(page.status().accepted, Revision(0));
    assert_eq!(page.status().outstanding, 1);
    assert!(!page.status().paused);
}

#[test]
fn an_error_ack_pauses_input_but_queries_work_and_the_draft_stays_copyable() {
    let mut page = PortableSession::open(SessionToken(9), "a", Revision(0));
    let applied = page.replace(Revision(0), at(0, 0), "!").unwrap();
    let mut failed = applied.request.accepted(Revision(0));
    failed.error = Some(HostError::new(HostErrorKind::Rejected, "append failed"));
    assert!(page.acknowledge(failed).unwrap().is_empty());
    assert!(page.status().paused);
    assert_eq!(
        page.replace(Revision(1), at(0, 0), "?"),
        Err(PortableError::Paused)
    );
    assert_eq!(page.draft_text(), "!a");
    assert!(page.project(Revision(1), at(0, 2)).is_ok());
    assert_eq!(page.copy_markdown(Revision(1), at(0, 2)).unwrap(), "!a");
    assert!(page.tags().is_ok());
}

#[test]
fn resume_resends_only_what_the_worker_lacks_in_order() {
    let mut page = PortableSession::open(SessionToken(10), "", Revision(0));
    let one = page.replace(Revision(0), at(0, 0), "a").unwrap();
    let two = page.replace(Revision(1), at(1, 1), "b").unwrap();
    let three = page.replace(Revision(2), at(2, 2), "c").unwrap();
    // The worker took the first edit; its reply and the other requests were lost.
    page.acknowledge(one.request.accepted(Revision(1))).unwrap();
    let resume = page.resume().unwrap();
    assert!(page.status().paused);
    assert_eq!(resume.sequence, 4);
    assert_eq!(resume.operation, HostOperation::Resume);
    assert_eq!(
        page.replace(Revision(3), at(3, 3), "d"),
        Err(PortableError::Paused)
    );
    let resent = page.acknowledge(resume.accepted(Revision(1))).unwrap();
    assert!(!page.status().paused);
    let revisions: Vec<_> = resent
        .iter()
        .map(|request| match &request.operation {
            HostOperation::Append(edit) => edit.revision,
            HostOperation::Resume => panic!("only edits are re-sent"),
        })
        .collect();
    assert_eq!(revisions, [Revision(2), Revision(3)]);
    let sequences: Vec<u64> = resent.iter().map(|request| request.sequence).collect();
    assert_eq!(sequences, [5, 6]);
    assert_ne!(resent[0], two.request);
    assert_ne!(resent[1], three.request);
    for request in &resent {
        let revision = match &request.operation {
            HostOperation::Append(edit) => edit.revision,
            HostOperation::Resume => unreachable!(),
        };
        page.acknowledge(request.accepted(revision)).unwrap();
    }
    assert_eq!(page.status().outstanding, 0);
    assert_eq!(page.status().accepted, Revision(3));
    // Old numbers are gone; a late reply for one is ignored.
    assert!(page
        .acknowledge(two.request.accepted(Revision(2)))
        .unwrap()
        .is_empty());
    assert!(page.replace(Revision(3), at(3, 3), "d").is_ok());
}

#[test]
fn resume_with_a_caught_up_worker_resends_nothing() {
    let mut page = PortableSession::open(SessionToken(16), "a", Revision(0));
    let applied = page.replace(Revision(0), at(0, 0), "!").unwrap();
    let resume = page.resume().unwrap();
    // The append's reply was lost but the worker had it.
    let resent = page.acknowledge(resume.accepted(Revision(1))).unwrap();
    assert!(resent.is_empty());
    assert_eq!(page.status().outstanding, 0);
    assert!(!page.status().paused);
    assert!(page
        .acknowledge(applied.request.accepted(Revision(1)))
        .unwrap()
        .is_empty());
}

#[test]
fn a_relink_offer_is_applied_only_at_the_revision_it_was_made_for() {
    use futo_notes_editor::RelinkOffer;
    let offer = |revision| {
        let mut page = PortableSession::open(SessionToken(17), "[[old]]", Revision(0));
        let applied = page.replace(Revision(0), at(0, 0), "x").unwrap();
        let mut ack = applied.request.accepted(Revision(1));
        ack.relink = Some(RelinkOffer {
            revision: Revision(revision),
            source: "x[[new]]".into(),
        });
        page.acknowledge(ack).unwrap();
        page
    };
    let mut stale = offer(0);
    assert!(stale.apply_relink_offer().unwrap().is_none());
    assert_eq!(stale.draft_text(), "x[[old]]");
    let mut current = offer(1);
    let applied = current.apply_relink_offer().unwrap().unwrap();
    assert_eq!(current.draft_text(), "x[[new]]");
    assert_eq!(applied.request.sequence, 2);
}

#[test]
fn portable_native_utf16_input_rejects_surrogate_splits_without_issuing_a_request() {
    use futo_notes_editor::{DisplayUtf16Offset, DisplayUtf16Range};
    let mut page = PortableSession::open(SessionToken(11), "a🎉b", Revision(0));
    let invalid = DisplayUtf16Range {
        start: DisplayUtf16Offset(2),
        end: DisplayUtf16Offset(2),
    };
    assert!(page
        .replace_utf16(Revision(0), invalid, &[b'!' as u16])
        .is_err());
    assert_eq!(page.draft_text(), "a🎉b");
    assert_eq!(page.status().outstanding, 0);
    let valid = DisplayUtf16Range {
        start: DisplayUtf16Offset(1),
        end: DisplayUtf16Offset(3),
    };
    let applied = page
        .replace_utf16(Revision(0), valid, &[0x65, 0x301])
        .unwrap();
    assert_eq!(page.draft_text(), "ae\u{301}b");
    assert_eq!(applied.change.inserted, "e\u{301}");
}

#[test]
fn recovered_host_pause_is_preserved_when_a_page_attaches() {
    use futo_notes_editor::HostSnapshot;
    let mut page = PortableSession::from_snapshot(HostSnapshot {
        token: SessionToken(12),
        source: "copy me".into(),
        revision: Revision(3),
        paused: true,
    })
    .unwrap();
    assert_eq!(page.draft_text(), "copy me");
    assert!(page.status().paused);
    assert!(page
        .replace(Revision(3), DisplayRange::default(), "!")
        .is_err());
    let resume = page.resume().unwrap();
    assert!(page
        .acknowledge(resume.accepted(Revision(3)))
        .unwrap()
        .is_empty());
    assert!(!page.status().paused);
}

#[test]
fn inline_projection_affinity_and_toggles_cross_the_portable_wire() {
    use futo_notes_editor::{Affinity, InlineFormat};
    let mut page = PortableSession::open(SessionToken(13), "__😀__*日*", Revision(0));
    let all = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(7),
    };
    assert_eq!(page.project(Revision(0), all).unwrap().text, "😀日");
    page.select_with_affinity(Revision(0), all, Affinity::Forward)
        .unwrap();
    let change = page
        .toggle_format(Revision(0), InlineFormat::Strike)
        .unwrap()
        .unwrap()
        .change;
    assert_eq!(page.draft_text(), "~~__😀__*日*~~");
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
    let mut page = PortableSession::open(SessionToken(14), "**a**_b_", Revision(0));
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
    assert_eq!(page.status().outstanding, 0);
    assert_eq!(
        page.active_formats().unwrap(),
        vec![InlineFormat::Italic, InlineFormat::Strike]
    );
    let change = page.replace(Revision(0), boundary, "日").unwrap().change;
    assert_eq!(page.draft_text(), "**a**_~~日~~b_");
    assert_eq!(change.selection.start, DisplayOffset(4));
}

#[test]
fn paused_recovered_source_remains_available_as_a_rich_display_projection() {
    let page = PortableSession::from_snapshot(futo_notes_editor::HostSnapshot {
        token: SessionToken(15),
        source: "__copy me__".into(),
        revision: Revision(3),
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
fn link_commands_apply_at_once_and_return_canonical_semantics_with_exact_history() {
    let mut page = PortableSession::open(SessionToken(101), "__docs__", Revision(0));
    let mut view = common::ReferenceView::new("docs");
    let range = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(4),
    };
    let applied = page
        .set_link(Revision(0), range, "https://x.test")
        .unwrap()
        .unwrap();
    // A destination that reads back as itself is written as given.
    assert_eq!(page.draft_text(), "[__docs__](https://x.test)");
    view.apply(applied.change);
    let link = page.inspect_link(Revision(1), range).unwrap().unwrap();
    assert_eq!(link.destination, "https://x.test");
    assert_eq!(link.range, range);
    let undo = page.undo(Revision(1)).unwrap().unwrap();
    view.apply(undo.change);
    assert_eq!(page.draft_text(), "__docs__");
    assert_eq!(view.text, "docs");
    assert!(page.inspect_link(Revision(2), range).unwrap().is_none());
}

#[test]
fn explicit_merge_adoption_mirrors_an_append_and_keeps_local_undo() {
    let mut page = PortableSession::open(SessionToken(7), "first\n\nsecond\n", Revision(0));
    let mut view = common::ReferenceView::new("first\n\nsecond\n");
    let edit = page.replace(Revision(0), at(7, 13), "LOCAL").unwrap();
    view.apply(edit.change);
    page.acknowledge(edit.request.accepted(Revision(1)))
        .unwrap();
    let adoption = page
        .adopt_merged_source(Revision(1), "REMOTE\n\nLOCAL\n")
        .unwrap();
    view.apply(adoption.change);
    assert_eq!(view.text, "REMOTE\n\nLOCAL\n");
    assert!(matches!(
        adoption.request.operation,
        HostOperation::Append(_)
    ));
    page.acknowledge(adoption.request.accepted(Revision(2)))
        .unwrap();
    let undo = page.undo(Revision(2)).unwrap().unwrap();
    view.apply(undo.change);
    assert_eq!(view.text, "REMOTE\n\nsecond\n");
    page.acknowledge(undo.request.accepted(Revision(3)))
        .unwrap();
    assert!(page.undo(Revision(3)).unwrap().is_none());
}
