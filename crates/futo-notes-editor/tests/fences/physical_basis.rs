use super::*;

#[test]
fn physical_row_endpoint_basis_keeps_source_intent_history_and_fresh_projection() {
    let mut count = 0;
    for eol in ["\n", "\r\n"] {
        for closed in [false, true] {
            for depth in 0..=2 {
                for origin in ["", "__head__\n\n"] {
                    for blank in [false, true] {
                        let prefix = "> ".repeat(depth);
                        let head = format!("{origin}{prefix}~~~~Rust unknown{eol}{prefix}");
                        let tail = if closed {
                            format!("{eol}{prefix}~~~~~  ")
                        } else {
                            eol.into()
                        };
                        let middle = if blank {
                            format!("{eol}{prefix}")
                        } else {
                            String::new()
                        };
                        let source = format!("{head}a{eol}{prefix}{middle}b{tail}");
                        let shown_origin = if origin.is_empty() { "" } else { "head\n\n" };
                        let shown_middle = if blank { eol } else { "" };
                        let shown = format!("{shown_origin}a{eol}{shown_middle}b");
                        let start = shown_origin.len();
                        // Literal source templates independently retain the first
                        // prefix and frame. Only the selected boundary retires a
                        // continuation; insertions at either side retain it.
                        for (selected, input, expected, display) in [
                            (
                                range(start + 1, start + 1 + eol.len()),
                                "X",
                                format!("{head}aX{middle}b{tail}"),
                                format!("{shown_origin}aX{shown_middle}b"),
                            ),
                            (
                                range(start + 1, start + 1),
                                "X",
                                format!("{head}aX{eol}{prefix}{middle}b{tail}"),
                                format!("{shown_origin}aX{eol}{shown_middle}b"),
                            ),
                            (
                                range(start + 1 + eol.len(), start + 1 + eol.len()),
                                "X",
                                format!("{head}a{eol}{prefix}X{middle}b{tail}"),
                                format!("{shown_origin}a{eol}X{shown_middle}b"),
                            ),
                            (
                                range(start, start),
                                "X",
                                format!("{head}Xa{eol}{prefix}{middle}b{tail}"),
                                format!("{shown_origin}Xa{eol}{shown_middle}b"),
                            ),
                            (
                                range(shown.len(), shown.len()),
                                "X",
                                format!("{head}a{eol}{prefix}{middle}bX{tail}"),
                                format!("{shown}X"),
                            ),
                            (
                                range(start + 1, start + 1),
                                "\n",
                                format!("{head}a\n{prefix}{eol}{prefix}{middle}b{tail}"),
                                format!("{shown_origin}a\n{eol}{shown_middle}b"),
                            ),
                        ] {
                            let mut session = EditorSession::open(&source);
                            let mut view = ReferenceView::new(&shown);
                            assert_fresh_projection(&session, &shown);
                            session
                                .select_with_affinity(Revision(0), selected, Affinity::Forward)
                                .unwrap();
                            assert!(matches!(
                                session.replace_action(
                                    Revision(0),
                                    selected,
                                    input,
                                    InputAction::Isolated,
                                    &mut |_| Err("reject physical row edit".into())
                                ),
                                Err(EditorError::Persistence(_))
                            ));
                            assert_eq!(session.source_text(), source);
                            assert_eq!(session.revision(), Revision(0));
                            assert_eq!(session.selection(), selected);
                            assert_eq!(session.affinity(), Affinity::Forward);
                            assert!(session
                                .undo(Revision(0), &mut |_| panic!("rejected history"))
                                .unwrap()
                                .is_none());
                            let mut accepts = 0;
                            let selected_utf16 = session
                                .display_to_utf16(session.revision(), selected)
                                .unwrap();
                            let change = session
                                .replace_utf16_action(
                                    session.revision(),
                                    selected_utf16,
                                    &input.encode_utf16().collect::<Vec<_>>(),
                                    InputAction::Isolated,
                                    &mut |_| {
                                        accepts += 1;
                                        Ok(())
                                    },
                                )
                                .unwrap();
                            assert_eq!(change.selection, session.selection());
                            assert_eq!(change.affinity, session.affinity());
                            view.apply(change);
                            assert_eq!(accepts, 1);
                            assert_eq!(
                                session.source_text(),
                                expected,
                                "{source:?} {selected:?} {input:?}"
                            );
                            assert_eq!(view.text, display);
                            assert_fresh_projection(&session, &display);
                            let caret = range(
                                selected.start.0 + input.len(),
                                selected.start.0 + input.len(),
                            );
                            assert_eq!(session.selection(), caret);
                            session
                                .select_with_affinity(session.revision(), caret, session.affinity())
                                .unwrap();
                            view.apply(
                                session
                                    .undo(session.revision(), &mut |_| Ok(()))
                                    .unwrap()
                                    .unwrap(),
                            );
                            assert_eq!(session.source_text(), source);
                            assert_eq!(view.text, shown);
                            assert_fresh_projection(&session, &shown);
                            view.apply(
                                session
                                    .redo(session.revision(), &mut |_| Ok(()))
                                    .unwrap()
                                    .unwrap(),
                            );
                            assert_eq!(session.source_text(), expected);
                            assert_eq!(view.text, display);
                            assert_fresh_projection(&session, &display);
                            count += 1;
                        }
                    }
                }
            }
        }
    }
    assert_eq!(count, 288);
}

#[test]
fn blank_and_nonblank_last_rows_keep_end_carets_in_code_across_public_inputs() {
    let mut count = 0;
    for eol in ["\n", "\r\n"] {
        for closed in [false, true] {
            for depth in 0..=2 {
                for origin in ["", "__猫🦊__\n\n"] {
                    for blank in [false, true] {
                        let prefix = "> ".repeat(depth);
                        let head = format!("{origin}{prefix}````Rust{eol}{prefix}");
                        let body = if blank {
                            format!("a{eol}{prefix}")
                        } else {
                            "a".into()
                        };
                        let tail = if closed {
                            format!("{eol}{prefix}`````  ")
                        } else {
                            eol.into()
                        };
                        let source = format!("{head}{body}{tail}");
                        let shown_origin = if origin.is_empty() { "" } else { "猫🦊\n\n" };
                        let shown = if blank {
                            format!("{shown_origin}a{eol}")
                        } else {
                            format!("{shown_origin}a")
                        };
                        let expected = format!("{head}{body}X{tail}");
                        let display = format!("{shown}X");
                        for route in 0..4 {
                            let mut session = EditorSession::open(&source);
                            let mut view = ReferenceView::new(&shown);
                            assert_fresh_projection(&session, &shown);
                            let at = range(shown.len(), shown.len());
                            session
                                .select_with_affinity(Revision(0), at, Affinity::Backward)
                                .unwrap();
                            let mut accepts = 0;
                            let mut accept = |_: &SourceEdit| {
                                accepts += 1;
                                Ok(())
                            };
                            let change = match route {
                                0 => session
                                    .replace_action(
                                        session.revision(),
                                        at,
                                        "X",
                                        InputAction::Isolated,
                                        &mut accept,
                                    )
                                    .unwrap(),
                                1 => session
                                    .replace_os(session.revision(), at, "X", &[], &mut accept)
                                    .unwrap()
                                    .unwrap(),
                                2 => session
                                    .replace_many(
                                        session.revision(),
                                        &[DisplayReplacement {
                                            range: at,
                                            inserted: "X".into(),
                                        }],
                                        &mut accept,
                                    )
                                    .unwrap(),
                                _ => {
                                    let native =
                                        session.display_to_utf16(session.revision(), at).unwrap();
                                    session
                                        .compose_utf16(session.revision(), native, &[88])
                                        .unwrap();
                                    session
                                        .commit_composition(session.revision(), None, &mut accept)
                                        .unwrap()
                                        .unwrap()
                                }
                            };
                            assert_eq!(accepts, 1);
                            view.apply(change);
                            assert_eq!(session.source_text(), expected, "route {route} {source:?}");
                            assert_eq!(view.text, display);
                            assert_eq!(session.selection(), range(display.len(), display.len()));
                            assert_fresh_projection(&session, &display);
                            let caret = session.selection();
                            session
                                .select_with_affinity(session.revision(), caret, session.affinity())
                                .unwrap();
                            let blocks = session.project(session.revision(), caret).unwrap().blocks;
                            assert!(!blocks.is_empty());
                            assert!(blocks.iter().all(|b| b.code && b.quote_depth == depth));
                            let source_range = SourceRange {
                                start: SourceOffset(0),
                                end: SourceOffset(expected.len()),
                            };
                            let utf16 = session
                                .source_to_utf16(session.revision(), source_range)
                                .unwrap();
                            assert_eq!(
                                session
                                    .source_from_utf16(session.revision(), utf16)
                                    .unwrap(),
                                source_range
                            );
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
                            assert_fresh_projection(&session, &display);
                            count += 1;
                        }
                    }
                }
            }
        }
    }
    assert_eq!(count, 192);
}
