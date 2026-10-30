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
