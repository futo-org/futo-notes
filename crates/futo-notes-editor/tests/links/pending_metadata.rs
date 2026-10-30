use super::*;

#[test]
fn unfinished_urls_elsewhere_do_not_add_metadata_work_to_a_local_keystroke() {
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
        assert!(session
            .project(session.revision(), range(0, 14))
            .unwrap()
            .links
            .is_empty());
        assert!(
            change.work.link_metadata_items > 0,
            "metadata accounting must observe the edited unfinished URL"
        );
        work.push(change.work.link_metadata_items);
    }
    assert_eq!(
        work[0], work[1],
        "distant unfinished URL metadata must stay in its own rows"
    );
}

#[test]
fn unchanged_distant_composition_preserves_unfinished_url_metadata_through_word_end_history() {
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
    assert!(session
        .project(Revision(1), range(14, 30))
        .unwrap()
        .links
        .is_empty());
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
    assert!(
        session
            .project(Revision(3), range(14, 30))
            .unwrap()
            .links
            .is_empty(),
        "Undo must restore the unfinished URL in its actual source window"
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
fn space_composition_maps_a_following_correction_inside_the_delimiter_rewrite() {
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
        .compose(session.revision(), range(22, 22), " ")
        .unwrap();
    let mut accepts = 0;
    view.apply(
        session
            .replace(session.revision(), range(3, 4), "B", &mut |_| {
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
        .inspect_link(session.revision(), range(4, 20))
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
    assert_eq!(session.source_text(), "x \\*b https://x.test/a*");
    assert_eq!(view.text, "x *b https://x.test/a*");
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
fn url_conversion_retains_distinct_literal_and_entity_correction_targets() {
    for (initial, at, input, changed, shown, caret, pending, committed) in [
        (
            "x *b&#98; ",
            6,
            range(3, 4),
            "x *B&#98; https://x.test/a* ",
            "x Bb https://x.test/a ",
            3,
            "x \\*b&#98; https://x.test/a*",
            "x *b&#98; https://x.test/a* ",
        ),
        (
            "x *b&acE; ",
            10,
            range(7, 9),
            "x *b&#8766;z https://x.test/a* ",
            "x b∾z https://x.test/a ",
            7,
            "x \\*b&acE; https://x.test/a*",
            "x *b&acE; https://x.test/a* ",
        ),
    ] {
        let mut session = EditorSession::open(initial);
        let mut view = ReferenceView::new(&session.display_text());
        for (index, ch) in "https://x.test/a*".chars().enumerate() {
            let point = at + index;
            view.apply(
                session
                    .replace(
                        session.revision(),
                        range(point, point),
                        &ch.to_string(),
                        &mut |_| Ok(()),
                    )
                    .unwrap(),
            );
        }
        assert_eq!(session.source_text(), pending);
        let end = view.text.len();
        session
            .compose(session.revision(), range(end, end), " ")
            .unwrap();
        let replacement = if at == 6 { "B" } else { "z" };
        view.apply(
            session
                .replace(session.revision(), input, replacement, &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(session.source_text(), changed);
        assert_eq!(view.text, shown);
        assert_eq!(session.selection(), range(caret, caret));
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), committed);
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), pending);
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
        assert_eq!(session.source_text(), changed);
        assert_eq!(session.selection(), range(caret, caret));
    }
}

#[test]
fn whole_marked_url_text_finishes_only_when_a_separator_follows_its_closer() {
    for (typed, source, display, linked) in [
        (
            "x *b https://x.test/a*",
            "x \\*b https://x.test/a*",
            "x *b https://x.test/a*",
            false,
        ),
        (
            "x *b https://x.test/a* ",
            "x *b https://x.test/a* ",
            "x b https://x.test/a ",
            true,
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
        assert_eq!(!projection.links.is_empty(), linked);
        if linked {
            assert_eq!(projection.links[0].destination, "https://x.test/a");
        }
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
fn an_unmapped_inserted_entity_syntax_target_rejects_before_accept_and_can_retry() {
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    let marked = session.compose(Revision(0), range(0, 0), "&acE;").unwrap();
    let mut accepts = 0;
    assert_eq!(
        session.replace(Revision(0), range(1, 2), "A", &mut |_| {
            accepts += 1;
            Ok(())
        }),
        Err(futo_notes_editor::EditorError::UnrepresentableFormat)
    );
    assert_eq!(accepts, 0);
    assert_eq!(session.revision(), Revision(0));
    assert_eq!(session.source_text(), "");
    assert_eq!(session.composition(), Some(&marked));
    view.apply(
        session
            .commit_composition(Revision(0), None, &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(session.source_text(), "&acE;");
    assert_eq!(view.text, "∾\u{333}");
    assert_eq!(session.selection(), range(5, 5));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "");
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "&acE;");
    assert_eq!(view.text, "∾\u{333}");
}
