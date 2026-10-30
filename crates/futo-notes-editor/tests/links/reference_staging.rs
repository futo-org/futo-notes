use super::*;

#[test]
fn a_partial_compound_draft_escalates_before_mapping_targets_past_a_remote_definition() {
    use futo_notes_editor::DisplayReplacement;
    let original = "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n[one][id]\n\nbody\n\ntail";
    let changed = "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n\n\nBODY\n\ntail";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("preamble\n\nbuffer\n\none\n\nbody\n\ntail");
    assert_eq!(session.display_text(), view.text);
    let mut accepted = 0;
    view.apply(
        session
            .replace_many(
                Revision(0),
                &[
                    DisplayReplacement {
                        range: range(18, 21),
                        inserted: String::new(),
                    },
                    DisplayReplacement {
                        range: range(23, 27),
                        inserted: "BODY".into(),
                    },
                ],
                &mut |_| {
                    accepted += 1;
                    Ok(())
                },
            )
            .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, changed);
    assert_eq!(session.selection(), range(43, 43));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, "preamble\n\nbuffer\n\none\n\nbody\n\ntail");
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), changed);
    assert_eq!(session.selection(), range(43, 43));
}

#[test]
fn nested_composition_refreshes_an_exact_local_definition_before_following_input_and_history() {
    let original = "head\n\nbuffer\n\n[id]: /target 'T'\n\n[one][id]\n\nbody\n\ntail\n\noutside";
    let committed = "head\n\nbuffer\n\n[id]: /target 'T'\n\n\n\nbody\n\ntail\n\noutside";
    let changed = "head\n\nbuffer\n\n[id]: /target 'T'\n\n\n\nBODY\n\ntail\n\noutside";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("head\n\nbuffer\n\none\n\nbody\n\ntail\n\noutside");
    assert_eq!(session.display_text(), view.text);
    session.compose(Revision(0), range(14, 17), "").unwrap();
    let mut accepted = 0;
    view.apply(
        session
            .replace(Revision(0), range(16, 20), "BODY", &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, changed);
    assert_eq!(session.selection(), range(39, 39));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), committed);
    assert_eq!(view.text, committed);
    assert_eq!(session.selection(), range(33, 33));
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(
        view.text,
        "head\n\nbuffer\n\none\n\nbody\n\ntail\n\noutside"
    );
    view.apply(session.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), changed);
    assert_eq!(session.selection(), range(39, 39));
}

#[test]
fn exact_nested_origins_include_prior_edits_and_each_of_two_reference_use_changes() {
    let original =
        "head\n\nbuffer\n\n[id]: /target 'T'\n\n[one][id] [two][id]\n\nbody\n\ntail\n\noutside";
    let opening =
        "head\n\nBUFFER++\n\n[id]: /target 'T'\n\n[one][id] [two][id]\n\nbody\n\ntail\n\noutside";
    let marked = "head\n\nBUFFER++\n\n[id]: /target 'T'\n\n [two][id]\n\nbody\n\ntail\n\noutside";
    let changed =
        "head\n\nBUFFER++\n\n[id]: /target 'T'\n\n [two](</new> \"T\")\n\nbody\n\ntail\n\noutside";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("head\n\nbuffer\n\none two\n\nbody\n\ntail\n\noutside");
    view.apply(
        session
            .replace(Revision(0), range(6, 12), "BUFFER++", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), opening);
    session.compose(Revision(1), range(16, 19), "").unwrap();
    let mut accepted = 0;
    view.apply(
        session
            .set_link(Revision(1), range(17, 20), "/new", &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), changed);
    assert_eq!(
        view.text,
        "head\n\nBUFFER++\n\n[id]: /target 'T'\n\n two\n\nbody\n\ntail\n\noutside"
    );
    assert_eq!(session.selection(), range(36, 39));
    let target = session
        .inspect_link(Revision(2), range(36, 39))
        .unwrap()
        .unwrap();
    assert_eq!(target.destination, "/new");
    assert_eq!(target.title.as_deref(), Some("T"));
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), marked);
    assert_eq!(
        view.text,
        "head\n\nBUFFER++\n\n two\n\nbody\n\ntail\n\noutside"
    );
    assert_eq!(session.selection(), range(16, 16));
    view.apply(session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), opening);
    view.apply(session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(session.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), changed);
    assert_eq!(session.selection(), range(36, 39));
}

#[test]
fn os_replacement_returns_the_source_anchored_caret_after_remote_reference_visibility_changes() {
    let original = "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n[one][id]\n\nbody\n\ntail";
    let changed = "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n\n\nBODY\n\ntail";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("preamble\n\nbuffer\n\none\n\nbody\n\ntail");
    view.apply(
        session
            .replace_os(Revision(0), range(18, 27), "\n\nBODY", &[], &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, changed);
    assert_eq!(session.selection(), range(43, 43));
    view.apply(
        session
            .replace(Revision(1), session.selection(), "!", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n\n\nBODY!\n\ntail"
    );
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), changed);
    view.apply(session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), changed);
    assert_eq!(session.selection(), range(43, 43));
}

#[test]
fn composition_history_selections_follow_source_identity_when_a_remote_definition_becomes_visible()
{
    let original = "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n[one][id]\n\nbody\n\ntail";
    let committed = "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n\n\nbody\n\ntail";
    let changed = "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n\n\nBODY\n\ntail";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("preamble\n\nbuffer\n\none\n\nbody\n\ntail");
    session.compose(Revision(0), range(18, 21), "").unwrap();
    let mut accepts = 0;
    view.apply(
        session
            .replace(Revision(0), range(20, 24), "BODY", &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, changed);
    assert_eq!(session.selection(), range(43, 43));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), committed);
    assert_eq!(view.text, committed);
    assert_eq!(session.selection(), range(37, 37));
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, "preamble\n\nbuffer\n\none\n\nbody\n\ntail");
    view.apply(session.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.selection(), range(37, 37));
    view.apply(session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), changed);
    assert_eq!(session.selection(), range(43, 43));
}

#[test]
fn history_restores_interior_boundaries_in_two_distinct_decoded_atoms_with_both_affinities() {
    use futo_notes_editor::Affinity;
    for affinity in [Affinity::Forward, Affinity::Backward] {
        let original = "__&acE; / &NotEqualTilde;__ tail";
        let mut session = EditorSession::open(original);
        let mut view = ReferenceView::new("∾\u{333} / ≂\u{338} tail");
        session
            .select_with_affinity(Revision(0), range(3, 11), affinity)
            .unwrap();
        view.apply(
            session
                .replace(Revision(0), range(14, 18), "done", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(session.source_text(), "__&acE; / &NotEqualTilde;__ done");
        assert_eq!(view.text, "∾\u{333} / ≂\u{338} done");
        view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), original);
        assert_eq!(session.selection(), range(3, 11));
        assert_eq!(session.affinity(), affinity);
        view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), "__&acE; / &NotEqualTilde;__ done");
        assert_eq!(session.selection(), range(18, 18));
    }
}

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
