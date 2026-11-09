use super::*;

#[test]
fn retargeting_an_outer_list_preserves_the_owned_nested_list_depth() {
    let source = "- a\n  - b";
    let mut s = EditorSession::open(source);
    let mut view = ReferenceView::new("a\nb");
    s.select(s.revision(), range(0, 1)).unwrap();
    view.apply(
        s.block_command(
            s.revision(),
            range(0, 1),
            BlockCommand::OrderedList,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "1. a\n   - b");
    assert_eq!(view.text, "a\nb");
    assert_eq!(s.selection(), range(0, 1));
    let child = s.project(s.revision(), range(2, 3)).unwrap();
    assert_eq!(
        child
            .blocks
            .iter()
            .find_map(|block| block.list.as_ref())
            .unwrap()
            .depth,
        2
    );
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), source);
}
