use super::*;

#[test]
fn correction_and_reconversion_inside_a_nested_label_preserve_destination_and_exact_history() {
    let original = "see [teh __docs__](https://x.test 'T') tail\r\n";
    let corrected = "see [the __docs__](https://x.test 'T') tail\r\n";
    let reconverted = "see [the __資料__](https://x.test 'T') tail\r\n";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("see teh docs tail\r\n");
    view.apply(
        session
            .replace_os(
                Revision(0),
                range(0, 19),
                "see the docs tail\r\n",
                &[],
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), corrected);
    assert_eq!(view.text, "see the docs tail\r\n");
    session
        .compose(Revision(1), range(8, 12), "ドックス")
        .unwrap();
    assert_eq!(session.source_text(), corrected);
    view.apply(
        session
            .commit_composition(Revision(1), Some("資料"), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), reconverted);
    assert_eq!(view.text, "see the 資料 tail\r\n");
    assert_eq!(
        session
            .inspect_link(Revision(2), range(8, 11))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test"
    );
    assert!(session
        .commit_composition(Revision(2), None, &mut |_| panic!(
            "repeated commit appended"
        ))
        .unwrap()
        .is_none());
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), corrected);
    view.apply(session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(session.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), reconverted);
}
