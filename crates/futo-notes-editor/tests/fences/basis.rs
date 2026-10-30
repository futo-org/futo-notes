use super::*;

#[test]
fn finite_frame_basis_preserves_untouched_source_and_reopens_the_returned_display() {
    let mut cases = 0;
    for marker in ["```", "~~~~"] {
        for depth in 0..=2 {
            for eol in ["\n", "\r\n"] {
                for origin in ["", "__head__\r\n\r\n"] {
                    for closed in [false, true] {
                        let prefix = "> ".repeat(depth);
                        let head = format!("{origin}{prefix}{marker}Rust info{eol}{prefix}");
                        let tail = if closed {
                            format!("{eol}{prefix}{marker}  ")
                        } else {
                            eol.into()
                        };
                        let source = format!("{head}a{eol}{prefix}b{tail}");
                        let shown_origin = if origin.is_empty() {
                            ""
                        } else {
                            "head\r\n\r\n"
                        };
                        let shown = format!("{shown_origin}a{eol}b");
                        let start = shown_origin.len();
                        for (selected, inserted, expected, display) in [
                            (
                                range(start + 1, start + 1),
                                "*# &amp;",
                                format!("{head}a*# &amp;{eol}{prefix}b{tail}"),
                                format!("{shown_origin}a*# &amp;{eol}b"),
                            ),
                            (
                                range(start, shown.len()),
                                "",
                                format!("{head}{tail}"),
                                shown_origin.into(),
                            ),
                        ] {
                            let mut session = EditorSession::open(&source);
                            let mut view = ReferenceView::new(&shown);
                            assert_eq!(session.display_text(), shown, "{source:?}");
                            let mut accepts = 0;
                            view.apply(
                                session
                                    .replace_action(
                                        session.revision(),
                                        selected,
                                        inserted,
                                        InputAction::Isolated,
                                        &mut |_| {
                                            accepts += 1;
                                            Ok(())
                                        },
                                    )
                                    .unwrap(),
                            );
                            assert_eq!(accepts, 1);
                            assert_eq!(session.source_text(), expected, "{source:?}");
                            assert_eq!(view.text, display);
                            assert_eq!(session.display_text(), display);
                            assert_eq!(EditorSession::open(&expected).display_text(), display);
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
                            cases += 1;
                        }
                    }
                }
            }
        }
    }
    assert_eq!(cases, 96);
}

#[test]
fn final_authored_break_delete_retains_original_frame_in_the_finite_container_basis() {
    for marker in ["```", "~~~~"] {
        for depth in 0..=2 {
            for eol in ["\n", "\r\n"] {
                let prefix = "> ".repeat(depth);
                let source =
                    format!("{prefix}{marker}{eol}{prefix}a{eol}{prefix}{eol}{prefix}{marker}  ");
                let expected = format!("{prefix}{marker}{eol}{prefix}a{eol}{prefix}{marker}  ");
                for key in [ParagraphKey::Delete, ParagraphKey::Backspace] {
                    let mut session = EditorSession::open(&source);
                    let mut view = ReferenceView::new(&format!("a{eol}"));
                    let at = if key == ParagraphKey::Delete {
                        1
                    } else {
                        1 + eol.len()
                    };
                    view.apply(
                        session
                            .paragraph_key(session.revision(), range(at, at), key, &mut |_| Ok(()))
                            .unwrap()
                            .unwrap(),
                    );
                    assert_eq!(session.source_text(), expected);
                    assert_eq!(view.text, "a");
                    assert_eq!(EditorSession::open(&expected).display_text(), "a");
                }
            }
        }
    }
}
