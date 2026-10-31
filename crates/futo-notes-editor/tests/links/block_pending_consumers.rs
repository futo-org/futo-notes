//! Structural consumers must prepare retained transient fields before acceptance.
use super::*;
use futo_notes_editor::{BlockCommand, InlineFormat};

#[test]
fn a_divider_transports_the_live_code_scalar_into_its_unchanged_right_body() {
    let shown = "pre \n\u{fffc}\n\n<https://x.test/path>";
    let candidate = EditorSession::open("pre&#32;\n***\n\n<https\\://x.test`/path`>");
    assert_eq!(candidate.display_text(), shown);
    let candidate_query = candidate.project(Revision(0), range(0, 31)).unwrap();
    assert!(candidate_query.links.is_empty());
    assert!(candidate_query
        .runs
        .iter()
        .any(|run| run.range == range(25, 30) && run.formats.contains(&InlineFormat::Code)));
    let mut session = EditorSession::open("pre ");
    let mut view = ReferenceView::new("pre ");
    view.apply(
        session
            .replace(
                Revision(0),
                range(4, 4),
                "<https://x.test/path",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(
        session
            .replace(Revision(1), range(24, 24), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    session.select(Revision(2), range(19, 24)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let guarded = session.source_text();
    let mut accepts = 0;
    view.apply(
        session
            .block_command(Revision(3), range(4, 4), BlockCommand::Divider, &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(view.text, shown);
    let divided = session.source_text();
    let fresh = EditorSession::open(&divided);
    assert_eq!(fresh.display_text(), shown);
    let fresh_query = fresh.project(Revision(0), range(0, 31)).unwrap();
    assert!(fresh_query.links.is_empty());
    assert!(fresh_query
        .runs
        .iter()
        .any(|run| run.range == range(25, 30) && run.formats.contains(&InlineFormat::Code)));
    session.select(Revision(4), range(25, 30)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(4), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let released = session.source_text();
    session.select(Revision(5), range(31, 31)).unwrap();
    view.apply(
        session
            .replace(Revision(5), range(31, 31), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "pre \n\u{fffc}\n\n<https://x.test/path> ");
    let links = session.project(Revision(6), range(0, 32)).unwrap().links;
    assert_eq!(
        links.len(),
        1,
        "divided={divided:?}; released={released:?}; source={:?}",
        session.source_text()
    );
    assert_eq!(links[0].destination, "https://x.test/path");
    assert_eq!(links[0].range, range(11, 30));
    view.apply(session.undo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), released);
    view.apply(session.undo(Revision(7), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), divided);
    view.apply(session.undo(Revision(8), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), guarded);
    assert_eq!(view.text, "pre <https://x.test/path>");
}

#[test]
fn divider_uses_the_current_empty_snapshot_after_its_actual_word_end_retires_pending_uri() {
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    view.apply(
        session
            .replace(Revision(0), range(0, 0), "<https://x.test", &mut |_| Ok(()))
            .unwrap(),
    );
    view.apply(
        session
            .replace(Revision(1), range(15, 15), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), "<<https://x.test>>");
    assert!(session
        .inspect_link(Revision(2), range(1, 2))
        .unwrap()
        .is_none());
    let mut accepts = 0;
    view.apply(
        session
            .block_command(
                Revision(2),
                range(16, 16),
                BlockCommand::Divider,
                &mut |_| {
                    accepts += 1;
                    Ok(())
                },
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(session.source_text(), "<<https://x.test>>\n***\n");
    assert_eq!(view.text, "<https://x.test>\n\u{fffc}\n");
    assert_eq!(session.selection(), range(21, 21));
    assert_eq!(
        session
            .inspect_link(Revision(3), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test"
    );
    view.apply(session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "<<https://x.test>>");
    assert!(session
        .inspect_link(Revision(4), range(1, 2))
        .unwrap()
        .is_none());
    view.apply(session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "<<https://x.test>>\n***\n");
    assert_eq!(
        session
            .inspect_link(Revision(5), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test"
    );
}

#[test]
fn divider_keeps_both_identical_code_words_and_interior_entity_history_independent() {
    use futo_notes_editor::Affinity;
    for affinity in [Affinity::Forward, Affinity::Backward] {
        let mut session = EditorSession::open("&acE; ");
        let mut view = ReferenceView::new("\u{223e}\u{333} ");
        view.apply(
            session
                .replace(
                    Revision(0),
                    range(6, 6),
                    "<https://x.test/path",
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        view.apply(
            session
                .replace(Revision(1), range(26, 26), ">", &mut |_| Ok(()))
                .unwrap(),
        );
        session.select(Revision(2), range(21, 26)).unwrap();
        view.apply(
            session
                .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        session.select(Revision(3), range(27, 27)).unwrap();
        view.apply(
            session
                .replace(
                    Revision(3),
                    range(27, 27),
                    " / <https://x.test/path",
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        view.apply(
            session
                .replace(Revision(4), range(50, 50), ">", &mut |_| Ok(()))
                .unwrap(),
        );
        session.select(Revision(5), range(45, 50)).unwrap();
        view.apply(
            session
                .toggle_format(Revision(5), InlineFormat::Code, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        let guarded = session.source_text();
        let opening = "\u{223e}\u{333} <https://x.test/path> / <https://x.test/path>";
        assert_eq!(view.text, opening);
        session
            .select_with_affinity(Revision(6), range(3, 3), affinity)
            .unwrap();
        view.apply(
            session
                .block_command(
                    Revision(6),
                    range(27, 30),
                    BlockCommand::Divider,
                    &mut |_| Ok(()),
                )
                .unwrap()
                .unwrap(),
        );
        assert_eq!(
            view.text,
            "\u{223e}\u{333} <https://x.test/path>\n\u{fffc}\n\n<https://x.test/path>"
        );
        assert!(session
            .project(Revision(7), range(0, 54))
            .unwrap()
            .links
            .is_empty());
        session.select(Revision(7), range(21, 26)).unwrap();
        view.apply(
            session
                .toggle_format(Revision(7), InlineFormat::Code, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        session.select(Revision(8), range(27, 27)).unwrap();
        view.apply(
            session
                .replace(Revision(8), range(27, 27), " ", &mut |_| Ok(()))
                .unwrap(),
        );
        let first = session.project(Revision(9), range(0, 55)).unwrap().links;
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].range, range(7, 26));
        assert_eq!(first[0].destination, "https://x.test/path");
        session.select(Revision(9), range(49, 54)).unwrap();
        view.apply(
            session
                .toggle_format(Revision(9), InlineFormat::Code, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        session.select(Revision(10), range(55, 55)).unwrap();
        view.apply(
            session
                .replace(Revision(10), range(55, 55), " ", &mut |_| Ok(()))
                .unwrap(),
        );
        let both = session.project(Revision(11), range(0, 56)).unwrap().links;
        assert_eq!(
            both.iter().map(|link| link.range).collect::<Vec<_>>(),
            vec![range(7, 26), range(35, 54)]
        );
        assert!(both
            .iter()
            .all(|link| link.destination == "https://x.test/path"));
        assert!(session.source_text().starts_with("&acE; "));
        let loaded = EditorSession::open(&session.source_text());
        assert_eq!(loaded.display_text(), view.text);
        assert_eq!(
            loaded.project(Revision(0), range(0, 56)).unwrap().links,
            both
        );
        for _ in 0..5 {
            view.apply(
                session
                    .undo(session.revision(), &mut |_| Ok(()))
                    .unwrap()
                    .unwrap(),
            );
        }
        assert_eq!(session.source_text(), guarded);
        assert_eq!(view.text, opening);
        assert_eq!(session.selection(), range(3, 3));
        assert_eq!(session.affinity(), affinity);
        assert!(session
            .project(session.revision(), range(0, 51))
            .unwrap()
            .links
            .is_empty());
    }
}

#[test]
fn a_divider_preserves_live_scalar_lineage_through_quoted_setext_physical_prefixes() {
    let expected = "> head\n> ===\n\n> ***\n> \n> <https\\://x.test`/path`>\n> ===";
    let shown = "head\n\n\u{fffc}\n\n<https://x.test/path>";
    let candidate = EditorSession::open(expected);
    assert_eq!(candidate.display_text(), shown);
    let query = candidate.project(Revision(0), range(0, 32)).unwrap();
    assert!(query.links.is_empty());
    assert!(query
        .runs
        .iter()
        .any(|run| run.range == range(26, 31) && run.formats.contains(&InlineFormat::Code)));
    let mut session = EditorSession::open("> head\n> seed\n> ===");
    let mut view = ReferenceView::new("head\nseed");
    view.apply(
        session
            .replace(
                Revision(0),
                range(5, 9),
                "<https://x.test/path",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(
        session
            .replace(Revision(1), range(25, 25), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    session.select(Revision(2), range(20, 25)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let guarded = session.source_text();
    let fresh = EditorSession::open(&guarded);
    assert_eq!(fresh.display_text(), view.text);
    assert!(fresh
        .project(Revision(0), range(0, 26))
        .unwrap()
        .links
        .is_empty());
    view.apply(
        session
            .block_command(Revision(3), range(5, 5), BlockCommand::Divider, &mut |_| {
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), expected);
    assert_eq!(view.text, shown);
    session.select(Revision(4), range(26, 31)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(4), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let released = session.source_text();
    session.select(Revision(5), range(32, 32)).unwrap();
    view.apply(
        session
            .replace(Revision(5), range(32, 32), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    let links = session.project(Revision(6), range(0, 33)).unwrap().links;
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].range, range(12, 31));
    assert_eq!(links[0].destination, "https://x.test/path");
    view.apply(session.undo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), released);
    view.apply(session.undo(Revision(7), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), expected);
    view.apply(session.undo(Revision(8), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), guarded);
    assert_eq!(view.text, "head\n<https://x.test/path>");
}
