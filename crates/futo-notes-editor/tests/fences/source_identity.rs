use super::*;

#[test]
fn unchanged_multiline_code_runs_keep_each_physical_prefix() {
    let mut count = 0;
    for eol in ["\n", "\r\n"] {
        for depth in 0..=2 {
            for indent in [" ", "  "] {
                for closed in [false, true] {
                    for origin in ["", "__head__\n\n"] {
                        for changed in [false, true] {
                            for whole in [false, true] {
                                let p = "> ".repeat(depth);
                                let source = format!("{origin}{p}{indent}```Rust{eol}{p}{indent}aa{eol}{p}{eol}{p}{indent}b{eol}{}", if closed { format!("{p}{indent}```") } else { String::new() });
                                let head = if origin.is_empty() { "" } else { "head\n\n" };
                                let shown = format!("{head}aa{eol}{eol}b");
                                let start = head.len() + usize::from(!whole);
                                let end = shown.len() - usize::from(!whole || changed);
                                let mut runs = vec![DisplayReplacement {
                                    range: range(start, end),
                                    inserted: shown[start..end].into(),
                                }];
                                if changed {
                                    runs.push(DisplayReplacement {
                                        range: range(end, end + 1),
                                        inserted: "B".into(),
                                    });
                                }
                                let expected = if changed {
                                    source.replacen(&format!("{indent}b"), &format!("{indent}B"), 1)
                                } else {
                                    source.clone()
                                };
                                let display = if changed {
                                    shown.replacen('b', "B", 1)
                                } else {
                                    shown.clone()
                                };
                                let mut session = EditorSession::open(&source);
                                let mut view = ReferenceView::new(&shown);
                                let before = session.selection();
                                assert!(matches!(
                                    session.replace_many(session.revision(), &runs, &mut |_| Err(
                                        "append".into()
                                    )),
                                    Err(EditorError::Persistence(_))
                                ));
                                assert_eq!(session.source_text(), source);
                                assert_eq!(session.selection(), before);
                                assert_eq!(session.revision(), Revision(0));
                                let mut accepted = 0;
                                view.apply(
                                    session
                                        .replace_many(session.revision(), &runs, &mut |_| {
                                            accepted += 1;
                                            Ok(())
                                        })
                                        .unwrap(),
                                );
                                assert_eq!(accepted, 1);
                                assert_eq!(session.source_text(), expected, "{source:?}");
                                assert_eq!(view.text, display);
                                assert_eq!(
                                    session.selection(),
                                    range(end + usize::from(changed), end + usize::from(changed))
                                );
                                assert_fresh_projection(&session, &display);
                                view.apply(
                                    session
                                        .undo(session.revision(), &mut |_| Ok(()))
                                        .unwrap()
                                        .unwrap(),
                                );
                                assert_eq!(session.source_text(), source);
                                assert_eq!(view.text, shown);
                                assert!(session
                                    .undo(session.revision(), &mut |_| Ok(()))
                                    .unwrap()
                                    .is_none());
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
    }
    assert_eq!(count, 192);
}

#[test]
fn identical_code_raw_os_ime_and_empty_many_keep_their_acceptance_policies() {
    for eol in ["\n", "\r\n"] {
        for depth in 0..=2 {
            for closed in [false, true] {
                let p = "> ".repeat(depth);
                let source = format!(
                    "{p} ```Rust{eol}{p} a{eol}{p}{eol}{p} b{eol}{}",
                    if closed {
                        format!("{p} ```")
                    } else {
                        String::new()
                    }
                );
                let shown = format!("a{eol}{eol}b");
                for route in ["raw", "os", "ime", "empty-many"] {
                    let mut s = EditorSession::open(&source);
                    let mut view = ReferenceView::new(&shown);
                    let end = shown.len() - 1;
                    let selected = range(0, end);
                    s.select_with_affinity(s.revision(), selected, Affinity::Forward)
                        .unwrap();
                    let mut accepts = 0;
                    let mut accept = |_: &SourceEdit| {
                        accepts += 1;
                        Ok(())
                    };
                    let change = match route {
                        "raw" => Some(
                            s.replace_action(
                                s.revision(),
                                selected,
                                &shown[..end],
                                InputAction::Isolated,
                                &mut accept,
                            )
                            .unwrap(),
                        ),
                        "os" => s
                            .replace_os(s.revision(), selected, &shown[..end], &[], &mut accept)
                            .unwrap(),
                        "ime" => {
                            s.compose(s.revision(), selected, &shown[..end]).unwrap();
                            s.commit_composition(s.revision(), None, &mut accept)
                                .unwrap()
                        }
                        _ => Some(
                            s.replace_many(
                                s.revision(),
                                &[DisplayReplacement {
                                    range: range(0, 0),
                                    inserted: String::new(),
                                }],
                                &mut accept,
                            )
                            .unwrap(),
                        ),
                    };
                    let explicit = matches!(route, "raw" | "empty-many");
                    assert_eq!(accepts, usize::from(explicit));
                    assert_eq!(change.is_some(), explicit);
                    if let Some(change) = change {
                        view.apply(change);
                    }
                    assert_eq!(s.source_text(), source);
                    assert_eq!(view.text, shown);
                    assert_fresh_projection(&s, &shown);
                    if explicit {
                        let caret = if route == "empty-many" { 0 } else { end };
                        assert_eq!(s.selection(), range(caret, caret));
                        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
                        assert_eq!(s.selection(), selected);
                        assert_eq!(s.source_text(), source);
                        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
                        assert_eq!(s.selection(), range(caret, caret));
                        assert_eq!(s.source_text(), source);
                    } else {
                        assert!(s
                            .undo(s.revision(), &mut |_| panic!(
                                "unchanged OS/IME has no history"
                            ))
                            .unwrap()
                            .is_none());
                    }
                }
            }
        }
    }
}
