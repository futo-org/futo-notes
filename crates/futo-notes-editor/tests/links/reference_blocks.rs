use super::*;

#[test]
fn text_conversion_preserves_a_headings_literal_reference_definition_and_distant_label() {
    use futo_notes_editor::BlockCommand;
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
    // Independently pinned canonical comparison visits are separate from
    // the existing indexed component and unchanged fixed-work budget.
    for (work, references) in measured.iter_mut().zip([5, 9]) {
        // Block planning now also charges its two local row/seam inspections;
        // neither inspection reads the distant reference context.
        work.link_metadata_items -= references + 2;
    }
    // The public primitive ledger pins the new indexed component separately.
    assert_eq!(
        measured
            .iter()
            .map(|w| w.link_metadata_items)
            .collect::<Vec<_>>(),
        vec![157, 207]
    );
    for (work, nodes) in measured.iter_mut().zip([64, 114]) {
        work.link_metadata_items -= nodes + 8;
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

#[test]
fn text_conversion_reconciles_each_actual_quote_prefix_and_ordered_retained_body() {
    use futo_notes_editor::BlockCommand;
    for (original, changed, shown, selected) in [
        (
            "> # [id]: /target 'T'\n\n[one][id]\n\nbody",
            "> \\[id]: /target 'T'\n\n[one][id]\n\nbody",
            "[id]: /target 'T'\n\n[one][id]\n\nbody",
            range(4, 4),
        ),
        (
            "# [a]: /A\n\n# [b]: /B\n\n[one][a] [two][b]",
            "\\[a]: /A\n\n\\[b]: /B\n\n[one][a] [two][b]",
            "[a]: /A\n\n[b]: /B\n\n[one][a] [two][b]",
            range(1, 17),
        ),
    ] {
        let mut session = EditorSession::open(original);
        let mut view = ReferenceView::new(shown);
        assert_eq!(session.display_text(), shown);
        session.select(Revision(0), selected).unwrap();
        let mut accepted = 0;
        view.apply(
            session
                .block_command(Revision(0), selected, BlockCommand::Heading(0), &mut |_| {
                    accepted += 1;
                    Ok(())
                })
                .unwrap()
                .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(session.source_text(), changed);
        assert_eq!(view.text, shown);
        assert_eq!(session.selection(), selected);
        assert!(session
            .project(Revision(1), range(0, shown.len()))
            .unwrap()
            .links
            .is_empty());
        view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), original);
        assert_eq!(session.selection(), selected);
        view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), changed);
        assert_eq!(session.selection(), selected);
        assert_eq!(view.text, shown);
    }
}

#[test]
fn heading_split_preserves_literal_reference_body_in_its_actual_following_paragraph() {
    use futo_notes_editor::ParagraphKey;
    // Spec and accepted blocks/keys gold: middle heading Enter starts a paragraph.
    let original = "# prefix[id]: /target 'T'\n\n[one][id]\n\nbody";
    let entered = "# prefix\n\\[id]: /target 'T'\n\n[one][id]\n\nbody";
    let shown = "prefix\n[id]: /target 'T'\n\n[one][id]\n\nbody";
    assert_eq!(EditorSession::open(entered).display_text(), shown);
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("prefix[id]: /target 'T'\n\n[one][id]\n\nbody");
    session.select(Revision(0), range(6, 6)).unwrap();
    let mut accepted = 0;
    let change = session
        .paragraph_key(Revision(0), range(6, 6), ParagraphKey::Enter, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    let target = change.selection;
    view.apply(change);
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), entered);
    assert_eq!(view.text, shown);
    assert_eq!(target, range(7, 7));
    assert!(session
        .project(Revision(1), range(0, shown.len()))
        .unwrap()
        .links
        .is_empty());
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(session.selection(), range(6, 6));
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), entered);
    assert_eq!(session.selection(), target);
    view.apply(
        session
            .replace(Revision(3), target, "!", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "# prefix\n!\\[id]: /target 'T'\n\n[one][id]\n\nbody"
    );
    assert_eq!(view.text, "prefix\n![id]: /target 'T'\n\n[one][id]\n\nbody");
    view.apply(session.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), entered);
    view.apply(session.undo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
}

#[test]
fn heading_split_transports_quote_layout_and_whole_nonidentity_atoms_without_length_guessing() {
    use futo_notes_editor::{Affinity, ParagraphKey};
    for (original, entered, opening, shown, caret, after) in [
        (
            "> # prefix[id]: /target 'T'\n\n[one][id]",
            "> # prefix\n> \\[id]: /target 'T'\n\n[one][id]",
            "prefix[id]: /target 'T'\n\n[one][id]",
            "prefix\n[id]: /target 'T'\n\n[one][id]",
            6,
            7,
        ),
        (
            "# &acE;[id]: /target 'T'\n\n[one][id]",
            "# &acE;\n\\[id]: /target 'T'\n\n[one][id]",
            "\u{223e}\u{333}[id]: /target 'T'\n\n[one][id]",
            "\u{223e}\u{333}\n[id]: /target 'T'\n\n[one][id]",
            5,
            6,
        ),
    ] {
        for affinity in [Affinity::Forward, Affinity::Backward] {
            let mut session = EditorSession::open(original);
            let mut view = ReferenceView::new(opening);
            assert_eq!(session.display_text(), opening);
            // Byte3 is inside the entity's displayed representation in the
            // second case; source and display coincidentally both have length5.
            session
                .select_with_affinity(Revision(0), range(3, 3), affinity)
                .unwrap();
            let change = session
                .paragraph_key(
                    Revision(0),
                    range(caret, caret),
                    ParagraphKey::Enter,
                    &mut |_| Ok(()),
                )
                .unwrap()
                .unwrap();
            view.apply(change);
            assert_eq!(session.source_text(), entered);
            assert_eq!(view.text, shown);
            assert_eq!(session.selection(), range(after, after));
            assert!(session
                .project(Revision(1), range(0, shown.len()))
                .unwrap()
                .links
                .is_empty());
            view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(session.source_text(), original);
            assert_eq!(session.selection(), range(3, 3));
            assert_eq!(session.affinity(), affinity);
            view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(session.source_text(), entered);
            assert_eq!(session.selection(), range(after, after));
            assert_eq!(view.text, shown);
        }
    }
}

#[test]
fn multiline_quote_heading_split_reconciles_a_definition_after_a_retained_physical_prefix() {
    use futo_notes_editor::ParagraphKey;
    let original = "> head\n> prefix\n> [id]: /target 'T'\n> ===\n\n[one][id]";
    let entered = "> head\n> prefix\n> ===\n> \n> \\[id]: /target 'T'\n\n[one][id]";
    let opening = "head\nprefix\n[id]: /target 'T'\n\n[one][id]";
    let shown = "head\nprefix\n\n[id]: /target 'T'\n\n[one][id]";
    assert_eq!(EditorSession::open(entered).display_text(), shown);
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new(opening);
    assert_eq!(session.display_text(), opening);
    session.select(Revision(0), range(11, 11)).unwrap();
    let mut accepted = 0;
    view.apply(
        session
            .paragraph_key(Revision(0), range(11, 11), ParagraphKey::Enter, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), entered);
    assert_eq!(view.text, shown);
    assert_eq!(session.selection(), range(12, 12));
    assert!(session
        .project(Revision(1), range(0, shown.len()))
        .unwrap()
        .links
        .is_empty());
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(session.selection(), range(11, 11));
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), entered);
    assert_eq!(session.selection(), range(12, 12));
    assert_eq!(view.text, shown);
}

#[test]
fn multiline_physical_prefix_composition_retains_interior_entity_history_and_affinity() {
    use futo_notes_editor::{Affinity, ParagraphKey};
    let original = "> head\n> pre&acE;fix\n> [id]: /target 'T'\n> ===\n\n[one][id]";
    let entered = "> head\n> pre&acE;fix\n> ===\n> \n> \\[id]: /target 'T'\n\n[one][id]";
    let opening = "head\npre\u{223e}\u{333}fix\n[id]: /target 'T'\n\n[one][id]";
    let shown = "head\npre\u{223e}\u{333}fix\n\n[id]: /target 'T'\n\n[one][id]";
    for affinity in [Affinity::Forward, Affinity::Backward] {
        let mut session = EditorSession::open(original);
        let mut view = ReferenceView::new(opening);
        assert_eq!(session.display_text(), opening);
        session
            .select_with_affinity(Revision(0), range(11, 11), affinity)
            .unwrap();
        view.apply(
            session
                .paragraph_key(Revision(0), range(16, 16), ParagraphKey::Enter, &mut |_| {
                    Ok(())
                })
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), entered);
        assert_eq!(view.text, shown);
        assert_eq!(session.selection(), range(17, 17));
        view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), original);
        assert_eq!(session.selection(), range(11, 11));
        assert_eq!(session.affinity(), affinity);
        view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), entered);
        assert_eq!(session.selection(), range(17, 17));
        assert_eq!(view.text, shown);
    }
}
