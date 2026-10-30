use super::*;

#[test]
fn blank_row_indentation_stays_parser_owned_while_authored_spaces_stay_opaque() {
    // Hand-worked columns: opener indentation, exact blank-row spelling,
    // stripped prefix, opaque content. Extra authored spaces are not syntax.
    let rows = [
        (" ", "", "", ""),
        (" ", " ", " ", ""),
        (" ", "  ", " ", " "),
        ("  ", " ", " ", ""),
        ("  ", "  ", "  ", ""),
        ("  ", "   ", "  ", " "),
        ("   ", " ", " ", ""),
        ("   ", "  ", "  ", ""),
        ("   ", "   ", "   ", ""),
        ("   ", "    ", "   ", " "),
    ];
    let mut count = 0;
    for (indent, blank, stripped, opaque) in rows {
        for eol in ["\n", "\r\n"] {
            for depth in 0..=2 {
                for origin in ["", "__head__\n\n"] {
                    for closed in [false, true] {
                        let p = "> ".repeat(depth);
                        let head =
                            format!("{origin}{p}{indent}````Rust info{eol}{p}{indent}a{eol}");
                        let tail = if closed {
                            format!("{eol}{p}{indent}b{eol}{p}{indent}`````  ")
                        } else {
                            format!("{eol}{p}{indent}b{eol}")
                        };
                        let source = format!("{head}{p}{blank}{tail}");
                        let expected = format!("{head}{p}{stripped}X{opaque}{tail}");
                        let shown_origin = if origin.is_empty() { "" } else { "head\n\n" };
                        let shown = format!("{shown_origin}a{eol}{opaque}{eol}b");
                        let display = format!("{shown_origin}a{eol}X{opaque}{eol}b");
                        let at = shown_origin.len() + 1 + eol.len();
                        let mut session = EditorSession::open(&source);
                        let mut view = ReferenceView::new(&shown);
                        assert_fresh_projection(&session, &shown);
                        let mut accepts = 0;
                        let change = session
                            .replace_action(
                                session.revision(),
                                range(at, at),
                                "X",
                                InputAction::Isolated,
                                &mut |record| {
                                    accepts += 1;
                                    assert_eq!(record.removed, "");
                                    assert_eq!(record.inserted, "X");
                                    assert_eq!(
                                        record.range.start.0,
                                        head.len() + p.len() + stripped.len()
                                    );
                                    assert_eq!(record.range.start, record.range.end);
                                    Ok(())
                                },
                            )
                            .unwrap();
                        view.apply(change);
                        assert_eq!(accepts, 1);
                        assert_eq!(session.source_text(), expected, "{source:?}");
                        assert_eq!(view.text, display);
                        assert_eq!(session.selection(), range(at + 1, at + 1));
                        assert_fresh_projection(&session, &display);
                        view.apply(
                            session
                                .undo(session.revision(), &mut |_| Ok(()))
                                .unwrap()
                                .unwrap(),
                        );
                        assert_eq!(session.source_text(), source);
                        assert_eq!(view.text, shown);
                        view.apply(
                            session
                                .redo(session.revision(), &mut |_| Ok(()))
                                .unwrap()
                                .unwrap(),
                        );
                        assert_eq!(session.source_text(), expected);
                        assert_eq!(view.text, display);
                        count += 1;
                    }
                }
            }
        }
    }
    assert_eq!(count, 240);
}
