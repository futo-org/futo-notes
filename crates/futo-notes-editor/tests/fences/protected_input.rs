use super::*;

#[test]
fn code_os_and_explicit_runs_keep_opaque_unchanged_bytes_and_rejected_undo_state() {
    for os in [false, true] {
        let original = "~~~js\nab &amp; cd\n~~~~  \n\n__tail__";
        let mut session = EditorSession::open(original);
        let mut view = ReferenceView::new("ab &amp; cd\n\ntail");
        let change = if os {
            session
                .replace_os(
                    session.revision(),
                    range(0, 11),
                    "Ab &amp; CD",
                    &[],
                    &mut |_| Ok(()),
                )
                .unwrap()
                .unwrap()
        } else {
            session
                .replace_many(
                    session.revision(),
                    &[
                        DisplayReplacement {
                            range: range(0, 1),
                            inserted: "A".into(),
                        },
                        DisplayReplacement {
                            range: range(9, 11),
                            inserted: "CD".into(),
                        },
                    ],
                    &mut |_| Ok(()),
                )
                .unwrap()
        };
        view.apply(change);
        assert_eq!(
            session.source_text(),
            "~~~js\nAb &amp; CD\n~~~~  \n\n__tail__"
        );
        assert_eq!(view.text, "Ab &amp; CD\n\ntail");
        let selected = session.selection();
        assert!(matches!(
            session.undo(session.revision(), &mut |_| Err("append".into())),
            Err(EditorError::Persistence(_))
        ));
        assert_eq!(session.selection(), selected);
        assert_eq!(
            session.source_text(),
            "~~~js\nAb &amp; CD\n~~~~  \n\n__tail__"
        );
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), original);
        assert_eq!(view.text, "ab &amp; cd\n\ntail");
    }
}

#[test]
fn code_composition_cancel_commit_and_failed_acceptance_preserve_exact_fence_source() {
    let original = "```Rust info\nab &amp; cd\n````  \n\n__tail__";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("ab &amp; cd\n\ntail");
    session
        .compose(session.revision(), range(1, 1), "か")
        .unwrap();
    session.cancel_composition(session.revision()).unwrap();
    assert_eq!(session.source_text(), original);
    assert_eq!(session.display_text(), view.text);
    let marked = session
        .compose(session.revision(), range(1, 1), "か")
        .unwrap();
    assert!(matches!(
        session.commit_composition(session.revision(), None, &mut |_| Err("append".into())),
        Err(EditorError::Persistence(_))
    ));
    assert_eq!(session.composition(), Some(&marked));
    assert_eq!(session.source_text(), original);
    view.apply(
        session
            .commit_composition(session.revision(), None, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "```Rust info\naかb &amp; cd\n````  \n\n__tail__"
    );
    assert_eq!(view.text, "aかb &amp; cd\n\ntail");
    assert_eq!(session.selection(), range(4, 4));
    assert!(session
        .commit_composition(session.revision(), None, &mut |_| panic!("repeated commit"))
        .unwrap()
        .is_none());
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, "ab &amp; cd\n\ntail");
}

#[test]
fn compound_os_and_explicit_input_across_code_and_prose_keep_each_source_identity() {
    for os in [false, true] {
        let original = "~~~js\nab &amp; cd\n~~~~  \n\n__tail__";
        let mut session = EditorSession::open(original);
        let mut view = ReferenceView::new("ab &amp; cd\n\ntail");
        let change = if os {
            session
                .replace_os(
                    session.revision(),
                    range(0, 17),
                    "Ab &amp; cd\n\nTail",
                    &[],
                    &mut |_| Ok(()),
                )
                .unwrap()
                .unwrap()
        } else {
            session
                .replace_many(
                    session.revision(),
                    &[
                        DisplayReplacement {
                            range: range(0, 1),
                            inserted: "A".into(),
                        },
                        DisplayReplacement {
                            range: range(13, 14),
                            inserted: "T".into(),
                        },
                    ],
                    &mut |_| Ok(()),
                )
                .unwrap()
        };
        view.apply(change);
        assert_eq!(
            session.source_text(),
            "~~~js\nAb &amp; cd\n~~~~  \n\n__Tail__"
        );
        assert_eq!(view.text, "Ab &amp; cd\n\nTail");
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), original);
    }
}

#[test]
fn global_os_and_explicit_code_runs_preserve_the_unselected_terminal_frame() {
    for os in [false, true] {
        let source = "__head__\r\n\r\n> ~~~Rust\r\n> ab &amp; cd\r\n> ~~~~~  ";
        let expected = "__head__\r\n\r\n> ~~~Rust\r\n> Ab &amp; CD\r\n> ~~~~~  ";
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new("head\r\n\r\nab &amp; cd");
        assert_eq!(session.display_text(), view.text);
        let change = if os {
            session
                .replace_os(
                    session.revision(),
                    range(8, 19),
                    "Ab &amp; CD",
                    &[],
                    &mut |_| Ok(()),
                )
                .unwrap()
                .unwrap()
        } else {
            session
                .replace_many(
                    session.revision(),
                    &[
                        DisplayReplacement {
                            range: range(8, 9),
                            inserted: "A".into(),
                        },
                        DisplayReplacement {
                            range: range(17, 19),
                            inserted: "CD".into(),
                        },
                    ],
                    &mut |_| Ok(()),
                )
                .unwrap()
        };
        view.apply(change);
        assert_eq!(session.source_text(), expected);
        assert_eq!(view.text, "head\r\n\r\nAb &amp; CD");
        assert_eq!(EditorSession::open(expected).display_text(), view.text);
        assert_eq!(session.selection(), range(19, 19));
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), source);
        assert_eq!(view.text, "head\r\n\r\nab &amp; cd");
    }
}
