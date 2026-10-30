use super::*;

#[test]
fn text_conversion_preserves_a_headings_literal_reference_definition_and_distant_label() {
    use futo_notes_editor::BlockCommand;
    // Real shipping toolbar oracle: referenceBlockShippingOracle.test.ts.
    let original = "# [id]: /target 'T'\n\n[one][id]\n\nbody";
    let changed = "\\[id]: /target 'T'\n\n[one][id]\n\nbody";
    let shown = "[id]: /target 'T'\n\n[one][id]\n\nbody";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new(shown);
    assert_eq!(session.display_text(), shown);
    session.select(Revision(0), range(4, 4)).unwrap();
    let mut accepted = 0;
    view.apply(
        session
            .block_command(
                Revision(0),
                range(4, 4),
                BlockCommand::Heading(0),
                &mut |_| {
                    accepted += 1;
                    Ok(())
                },
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, shown);
    assert_eq!(session.display_text(), shown);
    assert_eq!(session.selection(), range(4, 4));
    assert!(session
        .inspect_link(Revision(1), range(20, 23))
        .unwrap()
        .is_none());
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, shown);
    assert_eq!(session.selection(), range(4, 4));
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, shown);
    assert_eq!(session.selection(), range(4, 4));
}

#[test]
fn text_conversion_keeps_existing_definition_winners_duplicates_and_code_opaque() {
    use futo_notes_editor::BlockCommand;
    let original = "# [new]: /target 'T'\n\n[one][keep]\n\n[keep]: /first 'First'\n\n[keep]: /second 'Later'\n\n```\n[new]: /code\n```";
    let changed = "\\[new]: /target 'T'\n\n[one][keep]\n\n[keep]: /first 'First'\n\n[keep]: /second 'Later'\n\n```\n[new]: /code\n```";
    let shown = "[new]: /target 'T'\n\none\n\n[keep]: /second 'Later'\n\n[new]: /code";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new(shown);
    assert_eq!(session.display_text(), shown);
    view.apply(
        session
            .block_command(
                Revision(0),
                range(4, 4),
                BlockCommand::Heading(0),
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, shown);
    let target = session
        .inspect_link(Revision(1), range(20, 21))
        .unwrap()
        .unwrap();
    assert_eq!(target.destination, "/first");
    assert_eq!(target.title.as_deref(), Some("First"));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, shown);
}

#[test]
fn ordinary_heading_text_conversion_does_not_scan_distant_reference_context() {
    use futo_notes_editor::BlockCommand;
    let mut measured = Vec::new();
    for count in [20, 200] {
        let tail = "[other][keep]\n\n".repeat(count);
        let original = format!("# body\n\nbuffer\n\n{tail}[keep]: /kept 'T'");
        let mut session = EditorSession::open(&original);
        let change = session
            .block_command(
                Revision(0),
                range(2, 2),
                BlockCommand::Heading(0),
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), original[2..]);
        measured.push(change.work);
    }
    assert_eq!(measured[0], measured[1]);
}

#[test]
fn text_conversion_preserves_a_semantic_shortcut_before_definition_shaped_literal_text() {
    use futo_notes_editor::BlockCommand;
    // Real toolbar and independently parsed full-tail candidate agree.
    let original = "# [id]: /target 'T'\n\n[one][id]\n\n[id]: /first 'First'";
    let changed = "[id][id]: /target 'T'\n\n[one][id]\n\n[id]: /first 'First'";
    let shown = "id: /target 'T'\n\none\n\n";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new(shown);
    assert_eq!(session.display_text(), shown);
    session.select(Revision(0), range(1, 1)).unwrap();
    let mut accepted = 0;
    view.apply(
        session
            .block_command(
                Revision(0),
                range(1, 1),
                BlockCommand::Heading(0),
                &mut |_| {
                    accepted += 1;
                    Ok(())
                },
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, shown);
    assert_eq!(session.selection(), range(1, 1));
    for at in [0, 17] {
        let target = session
            .inspect_link(Revision(1), range(at, at + 1))
            .unwrap()
            .unwrap();
        assert_eq!(target.destination, "/first");
        assert_eq!(target.title.as_deref(), Some("First"));
    }
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, shown);
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, shown);
}

#[test]
fn text_conversion_keeps_marked_reference_labels_and_interior_entity_history_points() {
    use futo_notes_editor::{Affinity, BlockCommand};
    for (label, text, selected) in [
        ("**i&#100;**", "id", range(0, 2)),
        ("a&acE;", "a\u{223e}\u{333}", range(1, 4)),
    ] {
        for affinity in [Affinity::Forward, Affinity::Backward] {
            let suffix = format!(": /target 'T'\n\n[one][{label}]\n\n[{label}]: /first 'First'");
            let original = format!("# [{label}]{suffix}");
            let changed = format!("[{label}][{label}]{suffix}");
            let shown = format!("{text}: /target 'T'\n\none\n\n");
            let mut session = EditorSession::open(&original);
            let mut view = ReferenceView::new(&shown);
            assert_eq!(session.display_text(), shown);
            session
                .select_with_affinity(Revision(0), selected, affinity)
                .unwrap();
            let before = session.project(Revision(0), range(0, text.len())).unwrap();
            view.apply(
                session
                    .block_command(Revision(0), selected, BlockCommand::Heading(0), &mut |_| {
                        Ok(())
                    })
                    .unwrap()
                    .unwrap(),
            );
            assert_eq!(session.source_text(), changed);
            assert_eq!(view.text, shown);
            assert_eq!(session.selection(), selected);
            assert_eq!(session.affinity(), affinity);
            let after = session.project(Revision(1), range(0, text.len())).unwrap();
            assert_eq!(before.runs, after.runs);
            let target = session
                .inspect_link(Revision(1), range(0, text.len()))
                .unwrap()
                .unwrap();
            assert_eq!(target.destination, "/first");
            assert_eq!(target.title.as_deref(), Some("First"));
            view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(session.source_text(), original);
            assert_eq!(session.selection(), selected);
            assert_eq!(session.affinity(), affinity);
            view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(session.source_text(), changed);
            assert_eq!(session.selection(), selected);
            assert_eq!(session.affinity(), affinity);
            assert_eq!(view.text, shown);
        }
    }
}
