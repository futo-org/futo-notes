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
                                let mut runs = vec![DisplayReplacement { range: range(start, end), inserted: shown[start..end].into() }];
                                if changed { runs.push(DisplayReplacement { range: range(end, end + 1), inserted: "B".into() }); }
                                let expected = if changed { source.replacen(&format!("{indent}b"), &format!("{indent}B"), 1) } else { source.clone() };
                                let display = if changed { shown.replacen('b', "B", 1) } else { shown.clone() };
                                let mut session = EditorSession::open(&source);
                                let mut view = ReferenceView::new(&shown);
                                let before = session.selection();
                                assert!(matches!(session.replace_many(session.revision(), &runs, &mut |_| Err("append".into())), Err(EditorError::Persistence(_))));
                                assert_eq!(session.source_text(), source);
                                assert_eq!(session.selection(), before);
                                assert_eq!(session.revision(), Revision(0));
                                let mut accepted = 0;
                                view.apply(session.replace_many(session.revision(), &runs, &mut |_| { accepted += 1; Ok(()) }).unwrap());
                                assert_eq!(accepted, 1);
                                assert_eq!(session.source_text(), expected, "{source:?}");
                                assert_eq!(view.text, display);
                                assert_eq!(session.selection(), range(end + usize::from(changed), end + usize::from(changed)));
                                assert_fresh_projection(&session, &display);
                                view.apply(session.undo(session.revision(), &mut |_| Ok(())).unwrap().unwrap());
                                assert_eq!(session.source_text(), source);
                                assert_eq!(view.text, shown);
                                assert!(session.undo(session.revision(), &mut |_| Ok(())).unwrap().is_none());
                                view.apply(session.redo(session.revision(), &mut |_| Ok(())).unwrap().unwrap());
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
    assert_eq!(count, 384);
}
