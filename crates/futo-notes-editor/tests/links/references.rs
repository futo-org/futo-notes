use super::*;

#[test]
fn a_full_reference_label_edits_locally_without_rewriting_its_definition_or_title() {
    let original = "see [teh __docs__][id]\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail";
    let corrected = "see [the __docs__][id]\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("see teh docs\r\n\r\ntail");
    assert_eq!(session.display_text(), view.text);
    let link = session
        .inspect_link(Revision(0), range(5, 6))
        .unwrap()
        .unwrap();
    assert_eq!(link.range, range(4, 12));
    assert_eq!(link.destination, "https://x.test/a");
    assert_eq!(link.title.as_deref(), Some("Title"));
    view.apply(
        session
            .replace(Revision(0), range(4, 7), "the", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), corrected);
    assert_eq!(view.text, "see the docs\r\n\r\ntail");
    assert_eq!(EditorSession::open(corrected).display_text(), view.text);
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), corrected);
}

#[test]
fn ordinary_reference_label_and_body_edits_do_not_copy_or_scan_distant_definitions_or_uses() {
    for growing in ["definitions", "uses", "tail"] {
        let mut work = Vec::new();
        for count in [20, 200] {
            let tail = match growing {
                "definitions" => (0..count)
                    .map(|index| format!("[unused{index}]: https://unused.test/{index}\n\n"))
                    .collect::<String>(),
                "uses" => "[other][focus]\n\n".repeat(count),
                _ => "distant body\n\n".repeat(count),
            };
            let source =
                format!("[teh][focus]\n\nbody\n\n{tail}[focus]: https://x.test \"Title\"\n\nend");
            let corrected =
                format!("[the][focus]\n\nbody\n\n{tail}[focus]: https://x.test \"Title\"\n\nend");
            let mut session = EditorSession::open(&source);
            let label = session
                .replace(Revision(0), range(0, 3), "the", &mut |_| Ok(()))
                .unwrap();
            assert_eq!(session.source_text(), corrected);
            assert!(session.display_text().starts_with("the\n\nbody\n\n"));
            assert!(label.work.link_metadata_items > 0);
            assert!(label.work.link_copied_bytes > 0);
            let body = session
                .replace(Revision(1), range(5, 9), "BODY", &mut |_| Ok(()))
                .unwrap();
            assert!(session.display_text().starts_with("the\n\nBODY\n\n"));
            work.push((label.work, body.work));
        }
        assert_eq!(work[0], work[1], "local work grew with unrelated {growing}");
    }
}

#[test]
fn shortcut_and_collapsed_label_corrections_retain_definition_identity_with_a_full_tail() {
    for before in ["[teh]", "[teh][]"] {
        let original = format!("{before}\r\n\r\n[teh]: <https://x.test/a> 'Title'\r\n\r\ntail");
        let corrected = "[the][teh]\r\n\r\n[teh]: <https://x.test/a> 'Title'\r\n\r\ntail";
        let mut session = EditorSession::open(&original);
        let mut view = ReferenceView::new("teh\r\n\r\ntail");
        assert_eq!(session.display_text(), view.text);
        view.apply(
            session
                .replace(Revision(0), range(0, 3), "the", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(session.source_text(), corrected);
        assert_eq!(view.text, "the\r\n\r\ntail");
        let link = session
            .inspect_link(Revision(1), range(0, 3))
            .unwrap()
            .unwrap();
        assert_eq!(link.destination, "https://x.test/a");
        assert_eq!(link.title.as_deref(), Some("Title"));
        assert_eq!(EditorSession::open(corrected).display_text(), view.text);
        view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), original);
        view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), corrected);
    }
}

#[test]
fn os_correction_and_nested_composition_keep_a_distant_reference_context() {
    let original = "see [teh __docs__][id] tail\r\n\r\nmiddle\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail";
    let corrected = "see [the __docs__][id] tail\r\n\r\nmiddle\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail";
    let reconverted = "see [the __資料__][id] tail\r\n\r\nmiddle\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("see teh docs tail\r\n\r\nmiddle\r\n\r\ntail");
    assert_eq!(session.display_text(), view.text);
    view.apply(
        session
            .replace_os(
                Revision(0),
                range(0, 19),
                "see the docs tail\r\n",
                &[],
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), corrected);
    assert_eq!(view.text, "see the docs tail\r\n\r\nmiddle\r\n\r\ntail");
    session
        .compose(Revision(1), range(8, 12), "ドックス")
        .unwrap();
    view.apply(
        session
            .replace(Revision(1), range(8, 20), "資料", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), reconverted);
    assert_eq!(view.text, "see the 資料 tail\r\n\r\nmiddle\r\n\r\ntail");
    let target = session
        .inspect_link(Revision(2), range(8, 14))
        .unwrap()
        .unwrap();
    assert_eq!(target.destination, "https://x.test/a");
    assert_eq!(target.title.as_deref(), Some("Title"));
    assert_eq!(EditorSession::open(reconverted).display_text(), view.text);
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    // Committing the marked text and the following input retain separate
    // history groups, as in the existing compound-composition contract.
    assert_eq!(session.source_text(), "see [the __ドックス__][id] tail\r\n\r\nmiddle\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail");
    view.apply(session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), corrected);
    view.apply(session.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(session.redo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(session.redo(Revision(7), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), reconverted);
}

#[test]
fn changing_one_reference_destination_retains_title_and_other_reference_meaning() {
    let original = "[__one__][id] and [two][id]\n\n[id]: <https://old.test> 'A title'\n\nend";
    let changed = "[__one__](<https://new.test> \"A title\") and [two][id]\n\n[id]: <https://old.test> 'A title'\n\nend";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("one and two\n\nend");
    session.select(Revision(0), range(1, 2)).unwrap();
    view.apply(
        session
            .set_link(
                Revision(0),
                range(1, 2),
                "https://new.test",
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, "one and two\n\nend");
    assert_eq!(session.selection(), range(1, 2));
    let first = session
        .inspect_link(Revision(1), range(0, 3))
        .unwrap()
        .unwrap();
    assert_eq!(first.destination, "https://new.test");
    assert_eq!(first.title.as_deref(), Some("A title"));
    let second = session
        .inspect_link(Revision(1), range(8, 11))
        .unwrap()
        .unwrap();
    assert_eq!(second.destination, "https://old.test");
    assert_eq!(second.title.as_deref(), Some("A title"));
    assert_eq!(EditorSession::open(changed).display_text(), view.text);
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), changed);
}
