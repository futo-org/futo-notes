use super::*;

#[test]
fn text_command_includes_a_next_item_first_text_endpoint_but_not_the_prior_text_end() {
    for (end, expected) in [
        (6, "first\nsecond\n- third"),
        (5, "first\n- second\n- third"),
    ] {
        let raw = "- first\n- second\n- third";
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new("first\nsecond\nthird");
        let selected = range(0, end);
        s.select_with_affinity(s.revision(), selected, Affinity::Backward)
            .unwrap();
        view.apply(
            s.block_command(
                s.revision(),
                selected,
                BlockCommand::Heading(0),
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "endpoint {end}");
        assert_eq!(view.text, "first\nsecond\nthird");
        assert_eq!(s.selection(), selected);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), Affinity::Backward);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}

#[test]
fn text_lifting_through_a_quote_inside_an_item_is_refused_unchanged() {
    // Lifting a list whose item contains a quoted list would respell the quote
    // across container levels; refused before acceptance (DECISIONS #20).
    for (raw, selected) in [
        (
            "- parent\n  > - child\n  >   - grandchild\n  > - sibling\n- following",
            range(7, 12),
        ),
        (
            "- outer\n  > - middle\n  >   > - child\n  >   >   - grandchild\n  >   > - inner sibling\n  > - middle sibling\n- following",
            range(13, 18),
        ),
    ] {
        let mut s = EditorSession::open(raw);
        s.select_with_affinity(s.revision(), selected, Affinity::Backward)
            .unwrap();
        assert!(matches!(
            s.block_command(
                s.revision(),
                selected,
                BlockCommand::Heading(0),
                &mut |_| panic!("accepted")
            ),
            Err(EditorError::UnrepresentableFormat)
        ));
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.revision(), Revision(0));
    }
}
