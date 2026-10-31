//! Divider validates reference eligibility in its real final parent.
use super::*;
use futo_notes_editor::BlockCommand;

#[test]
fn divider_keeps_a_newly_exposed_definition_literal_and_its_distant_reference_unresolved() {
    let original = "prefix [id]: /target 'T'\n\n[one][id]";
    let expected = "prefix \n***\n\n\\[id]: /target 'T'\n\n[one][id]";
    let shown = "prefix \n\u{fffc}\n\n[id]: /target 'T'\n\n[one][id]";
    let candidate = EditorSession::open(expected);
    assert_eq!(candidate.display_text(), shown);
    assert!(candidate
        .project(Revision(0), range(0, shown.len()))
        .unwrap()
        .links
        .is_empty());
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new(original);
    assert_eq!(session.display_text(), original);
    session.select(Revision(0), range(2, 2)).unwrap();
    let mut accepts = 0;
    view.apply(
        session
            .block_command(Revision(0), range(7, 7), BlockCommand::Divider, &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(
        view.text,
        shown,
        "actual source={:?}",
        session.source_text()
    );
    assert_eq!(session.source_text(), expected);
    assert_eq!(session.selection(), range(12, 12));
    assert!(session
        .project(Revision(1), range(0, shown.len()))
        .unwrap()
        .links
        .is_empty());
    let loaded = EditorSession::open(&session.source_text());
    assert_eq!(loaded.display_text(), shown);
    assert!(loaded
        .project(Revision(0), range(0, shown.len()))
        .unwrap()
        .links
        .is_empty());
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, original);
    assert_eq!(session.selection(), range(2, 2));
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(session.selection(), range(12, 12));
}

#[test]
fn divider_keeps_a_semantic_shortcut_and_existing_winner_duplicate_title_exact() {
    let original =
        "prefix [id]: /target 'T'\n\n[one][id]\n\n[id]: /first 'First'\n\n[id]: /second 'Later'";
    let expected = "prefix \n***\n\n[id][id]: /target 'T'\n\n[one][id]\n\n[id]: /first 'First'\n\n[id]: /second 'Later'";
    let shown = "prefix \n\u{fffc}\n\nid: /target 'T'\n\none\n\n[id]: /second 'Later'";
    let candidate = EditorSession::open(expected);
    assert_eq!(candidate.display_text(), shown);
    let expected_links = candidate
        .project(Revision(0), range(0, shown.len()))
        .unwrap()
        .links;
    assert_eq!(expected_links.len(), 2);
    assert!(expected_links
        .iter()
        .all(|link| link.destination == "/first" && link.title.as_deref() == Some("First")));
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("prefix id: /target 'T'\n\none\n\n[id]: /second 'Later'");
    assert_eq!(session.display_text(), view.text);
    view.apply(
        session
            .block_command(Revision(0), range(7, 7), BlockCommand::Divider, &mut |_| {
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(
        session
            .project(Revision(1), range(0, shown.len()))
            .unwrap()
            .links,
        expected_links
    );
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), expected);
    assert_eq!(
        session
            .project(Revision(3), range(0, shown.len()))
            .unwrap()
            .links,
        expected_links
    );
}

#[test]
fn ordinary_divider_does_not_scan_distant_reference_definitions_or_uses() {
    let mut measured = Vec::new();
    for count in [20, 200, 2000] {
        let original = format!(
            "alpha beta\n\nbuffer\n\n{}[keep]: /kept 'T'",
            "[other][keep]\n\n".repeat(count)
        );
        let mut session = EditorSession::open(&original);
        let change = session
            .block_command(Revision(0), range(6, 6), BlockCommand::Divider, &mut |_| {
                Ok(())
            })
            .unwrap()
            .unwrap();
        assert_eq!(
            session.source_text(),
            original.replacen("alpha beta", "alpha \n***\n\nbeta", 1)
        );
        measured.push(change.work);
    }
    for work in &measured[1..] {
        assert_eq!(
            work.materialized_source_bytes,
            measured[0].materialized_source_bytes
        );
        assert_eq!(work.inserted_bytes, measured[0].inserted_bytes);
        assert_eq!(work.parsed_source_bytes, measured[0].parsed_source_bytes);
        assert_eq!(work.link_copied_bytes, measured[0].link_copied_bytes);
        // Actual indexed tree visits may grow logarithmically; body/reference
        // traversal must not grow with the hundred-fold distant corpus.
        assert!(
            work.link_metadata_items
                .abs_diff(measured[0].link_metadata_items)
                <= 16,
            "ordinary indexed work must stay bounded: {measured:?}"
        );
    }
}

#[test]
fn a_definition_repair_shifts_only_the_current_live_scalar_after_the_divider() {
    use futo_notes_editor::{Affinity, InlineFormat};
    let original = "prefix [id]: /target 'T'\n";
    assert_eq!(original.len(), 25); // Complete first line, including LF.
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new(original);
    view.apply(
        session
            .replace(
                Revision(0),
                range(25, 25),
                "<https://x.test/path",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(
        session
            .replace(Revision(1), range(45, 45), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    session.select(Revision(2), range(40, 45)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let guarded = session.source_text();
    let opening = "prefix [id]: /target 'T'\n<https://x.test/path>";
    assert_eq!(view.text, opening);
    let expected = "prefix \n***\n\n\\[id]: /target 'T'\n<https\\://x.test`/path`>";
    let shown = "prefix \n\u{fffc}\n\n[id]: /target 'T'\n<https://x.test/path>";
    let candidate = EditorSession::open(expected);
    assert_eq!(candidate.display_text(), shown);
    assert!(candidate
        .project(Revision(0), range(0, 52))
        .unwrap()
        .links
        .is_empty());
    session
        .select_with_affinity(Revision(3), range(2, 2), Affinity::Forward)
        .unwrap();
    let mut accepts = 0;
    view.apply(
        session
            .block_command(Revision(3), range(7, 7), BlockCommand::Divider, &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(session.source_text(), expected);
    assert_eq!(view.text, shown);
    assert!(session
        .project(Revision(4), range(0, 52))
        .unwrap()
        .links
        .is_empty());
    session.select(Revision(4), range(46, 51)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(4), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let released = session.source_text();
    session.select(Revision(5), range(52, 52)).unwrap();
    view.apply(
        session
            .replace(Revision(5), range(52, 52), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        view.text,
        "prefix \n\u{fffc}\n\n[id]: /target 'T'\n<https://x.test/path> "
    );
    let links = session.project(Revision(6), range(0, 53)).unwrap().links;
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].range, range(32, 51));
    assert_eq!(links[0].destination, "https://x.test/path");
    view.apply(session.undo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), released);
    view.apply(session.undo(Revision(7), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), expected);
    view.apply(session.undo(Revision(8), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), guarded);
    assert_eq!(view.text, opening);
    assert_eq!(session.selection(), range(2, 2));
    assert_eq!(session.affinity(), Affinity::Forward);
}

#[test]
fn divider_preserves_literal_left_definition_exposure_before_its_returned_caret() {
    let original = "[id]: /target extra\n\n[one][id]";
    let expected = "\\[id]: /target\n***\n\n extra\n\n[one][id]";
    let shown = "[id]: /target\n\u{fffc}\n\n extra\n\n[one][id]";
    let edited = "\\[id]: /target\n***\nx\n extra\n\n[one][id]";
    let edited_view = "[id]: /target\n\u{fffc}\nx\n extra\n\n[one][id]";
    for (source, display) in [
        (original, original),
        (expected, shown),
        (edited, edited_view),
    ] {
        let candidate = EditorSession::open(source);
        assert_eq!(candidate.display_text(), display);
        assert!(candidate
            .project(Revision(0), range(0, display.len()))
            .unwrap()
            .links
            .is_empty());
    }
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new(original);
    session.select(Revision(0), range(2, 2)).unwrap();
    let mut accepted = 0;
    let change = session
        .block_command(
            Revision(0),
            range(13, 13),
            BlockCommand::Divider,
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        )
        .unwrap_or_else(|error| {
            panic!("valid left exposure failed; accepted={accepted}; {error:?}")
        })
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(change.selection, range(18, 18));
    view.apply(change);
    assert_eq!(session.source_text(), expected);
    assert_eq!(view.text, shown);
    assert!(session
        .project(Revision(1), range(0, shown.len()))
        .unwrap()
        .links
        .is_empty());
    let caret = session.selection();
    session.select(Revision(1), range(0, 0)).unwrap();
    session.select(Revision(1), caret).unwrap();
    view.apply(
        session
            .replace(Revision(1), caret, "x", &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap(),
    );
    assert_eq!(accepted, 2);
    assert_eq!(session.source_text(), edited);
    assert_eq!(view.text, edited_view);
    assert_eq!(session.selection(), range(19, 19));
    assert!(session
        .project(Revision(2), range(0, edited_view.len()))
        .unwrap()
        .links
        .is_empty());
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(session.selection(), range(18, 18));
    view.apply(session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, original);
    assert_eq!(session.selection(), range(2, 2));
    view.apply(session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), expected);
    view.apply(session.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), edited);
    assert_eq!(view.text, edited_view);
    let fresh = EditorSession::open(&edited);
    assert_eq!(fresh.display_text(), edited_view);
    assert!(fresh
        .project(Revision(0), range(0, edited_view.len()))
        .unwrap()
        .links
        .is_empty());
}
