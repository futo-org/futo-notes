use super::*;

#[test]
fn urls_elsewhere_do_not_add_link_work_to_a_local_keystroke() {
    let mut work = Vec::new();
    for count in [20, 200] {
        let mut session = EditorSession::open(&"x\n\n".repeat(count));
        for index in (0..count).rev() {
            session
                .replace(
                    session.revision(),
                    range(index * 3, index * 3 + 1),
                    "https://x.test",
                    &mut |_| Ok(()),
                )
                .unwrap();
        }
        let change = session
            .replace(session.revision(), range(8, 8), "x", &mut |_| Ok(()))
            .unwrap();
        assert!(session.source_text().starts_with("https://xx.test\n\n"));
        let links = session
            .project(session.revision(), range(0, 15))
            .unwrap()
            .links;
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].destination, "https://xx.test");
        assert!(change.work.link_metadata_items > 0);
        work.push(change.work);
    }
    // The old engine counted 1386 and 1340 link items for this keystroke.
    assert!(work[0].link_metadata_items <= 1340, "{:?}", work[0]);
    assert_eq!(
        work[0], work[1],
        "distant URLs must stay in their own lines"
    );
}

#[test]
fn an_unchanged_composition_over_a_url_then_a_space_keeps_exact_bytes_through_history() {
    let mut session = EditorSession::open("head\n\nbuffer\n\n\n\ntail");
    let mut view = ReferenceView::new("head\n\nbuffer\n\n\n\ntail");
    view.apply(
        session
            .replace(Revision(0), range(14, 14), "https://x.test/a", &mut |_| {
                Ok(())
            })
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "head\n\nbuffer\n\nhttps://x.test/a\n\ntail"
    );
    assert_eq!(
        session
            .project(Revision(1), range(14, 30))
            .unwrap()
            .links
            .len(),
        1
    );
    session
        .compose(Revision(1), range(14, 30), "https://x.test/a")
        .unwrap();
    view.apply(
        session
            .replace(Revision(1), range(30, 30), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "head\n\nbuffer\n\nhttps://x.test/a \n\ntail"
    );
    assert_eq!(
        session
            .project(Revision(2), range(14, 30))
            .unwrap()
            .links
            .len(),
        1
    );
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(
        session.source_text(),
        "head\n\nbuffer\n\nhttps://x.test/a\n\ntail"
    );
    assert_eq!(view.text, session.source_text());
    assert_eq!(
        session
            .project(Revision(3), range(14, 30))
            .unwrap()
            .links
            .len(),
        1
    );
    view.apply(session.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(
        session.source_text(),
        "head\n\nbuffer\n\nhttps://x.test/a \n\ntail"
    );
    assert_eq!(
        session
            .project(Revision(4), range(14, 30))
            .unwrap()
            .links
            .len(),
        1
    );
}

#[test]
fn a_correction_during_space_composition_after_an_italic_url_lands_on_its_letter() {
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    for ch in "x *b https://x.test/a*".chars() {
        let at = view.text.len();
        view.apply(
            session
                .replace(
                    session.revision(),
                    range(at, at),
                    &ch.to_string(),
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
    }
    session
        .compose(session.revision(), range(20, 20), " ")
        .unwrap();
    let mut accepts = 0;
    view.apply(
        session
            .replace(session.revision(), range(2, 3), "B", &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(session.source_text(), "x *B https://x.test/a* ");
    assert_eq!(view.text, "x B https://x.test/a ");
    assert_eq!(session.selection(), range(3, 3));
    let link = session
        .inspect_link(session.revision(), range(4, 19))
        .unwrap()
        .unwrap();
    assert_eq!(link.destination, "https://x.test/a");
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "x *b https://x.test/a* ");
    assert_eq!(view.text, "x b https://x.test/a ");
    assert_eq!(session.selection(), range(21, 21));
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "x *b https://x.test/a*");
    assert_eq!(view.text, "x b https://x.test/a");
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "x *B https://x.test/a* ");
    assert_eq!(session.selection(), range(3, 3));
}

#[test]
fn committed_marked_text_with_an_italic_url_saves_as_typed_through_history() {
    for (typed, source, display) in [
        (
            "x *b https://x.test/a*",
            "x *b https://x.test/a*",
            "x b https://x.test/a",
        ),
        (
            "x *b https://x.test/a* ",
            "x *b https://x.test/a* ",
            "x b https://x.test/a ",
        ),
    ] {
        let mut session = EditorSession::open("");
        let mut view = ReferenceView::new("");
        session.compose(Revision(0), range(0, 0), typed).unwrap();
        assert_eq!(session.source_text(), "");
        view.apply(
            session
                .commit_composition(Revision(0), None, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), source);
        assert_eq!(view.text, display);
        assert_eq!(session.selection(), range(display.len(), display.len()));
        let projection = session
            .project(Revision(1), range(0, display.len()))
            .unwrap();
        assert_eq!(projection.links.len(), 1);
        assert_eq!(projection.links[0].destination, "https://x.test/a");
        view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), "");
        assert_eq!(view.text, "");
        view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), source);
        assert_eq!(view.text, display);
    }
}

#[test]
fn correction_inside_newly_composed_formatted_url_text_keeps_its_inserted_identity() {
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    session
        .compose(Revision(0), range(0, 0), "x *b https://x.test/a* ")
        .unwrap();
    let mut accepts = 0;
    view.apply(
        session
            .replace(Revision(0), range(3, 4), "B", &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(session.source_text(), "x *B https://x.test/a* ");
    assert_eq!(view.text, "x B https://x.test/a ");
    assert_eq!(session.selection(), range(3, 3));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "x *b https://x.test/a* ");
    assert_eq!(session.selection(), range(21, 21));
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "");
    assert_eq!(view.text, "");
    view.apply(session.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.selection(), range(21, 21));
    view.apply(session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "x *B https://x.test/a* ");
    assert_eq!(session.selection(), range(3, 3));
}

#[test]
fn mixed_retained_and_inserted_equal_glyphs_remain_distinct_after_composition_conversion() {
    for (input, changed, display, caret) in [
        (
            range(3, 4),
            "x *B b https://x.test/a* ",
            "x B b https://x.test/a ",
            3,
        ),
        (
            range(5, 6),
            "x *b B https://x.test/a* ",
            "x b B https://x.test/a ",
            5,
        ),
    ] {
        let mut session = EditorSession::open("x *b ");
        let mut view = ReferenceView::new("x *b ");
        session
            .compose(Revision(0), range(5, 5), "b https://x.test/a* ")
            .unwrap();
        let mut accepts = 0;
        view.apply(
            session
                .replace(Revision(0), input, "B", &mut |_| {
                    accepts += 1;
                    Ok(())
                })
                .unwrap(),
        );
        assert_eq!(accepts, 1);
        assert_eq!(session.source_text(), changed);
        assert_eq!(view.text, display);
        assert_eq!(session.selection(), range(caret, caret));
        view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), "x *b b https://x.test/a* ");
        view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), "x *b ");
        view.apply(session.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
        view.apply(session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), changed);
        assert_eq!(session.selection(), range(caret, caret));
    }
}

#[test]
fn a_correction_inside_composed_entity_text_is_literal_text() {
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    session.compose(Revision(0), range(0, 0), "&acE;").unwrap();
    let mut accepts = 0;
    view.apply(
        session
            .replace(Revision(0), range(1, 2), "A", &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(session.source_text(), "&AcE;");
    assert_eq!(view.text, "&AcE;");
    assert_eq!(session.selection(), range(2, 2));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "&acE;");
    assert_eq!(view.text, "&acE;");
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "");
    view.apply(session.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "&AcE;");
    assert_eq!(view.text, "&AcE;");
}
