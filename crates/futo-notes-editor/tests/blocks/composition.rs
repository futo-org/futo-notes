use super::*;

#[test]
fn commands_commit_marked_text_before_formatting_with_distinct_exact_history() {
    let mut s = EditorSession::open("A\r\nend");
    let mut v = ReferenceView::new("A\r\nend");
    s.compose(s.revision(), range(1, 1), "日本").unwrap();
    let mut calls = 0;
    v.apply(
        s.block_command(
            s.revision(),
            range(7, 7),
            BlockCommand::Heading(2),
            &mut |_| {
                calls += 1;
                Ok(())
            },
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(calls, 1);
    assert!(s.composition().is_none());
    assert_eq!(s.source_text(), "## A日本\r\nend");
    assert_eq!(v.text, "A日本\r\nend");
    assert_eq!(s.selection(), range(7, 7));
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "A日本\r\nend");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "A\r\nend");
}
