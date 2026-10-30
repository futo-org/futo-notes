use super::*;

#[test]
fn opening_supported_list_spellings_hides_markers_and_retains_lazy_numbers() {
    let raw =
        "* **a**\r\n+ b\r\n- [X] done\r\n\r\n5) first\r\n1) second\r\n\r\n9. [ ] todo\r\n1. last";
    let shown = "a\r\nb\r\ndone\r\n\r\nfirst\r\nsecond\r\n\r\ntodo\r\nlast";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.display_text(), shown);
    view.apply(
        s.replace(s.revision(), range(1, 1), "!", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        s.source_text(),
        "* **a!**\r\n+ b\r\n- [X] done\r\n\r\n5) first\r\n1) second\r\n\r\n9. [ ] todo\r\n1. last"
    );
    assert_eq!(
        view.text,
        "a!\r\nb\r\ndone\r\n\r\nfirst\r\nsecond\r\n\r\ntodo\r\nlast"
    );
    assert_eq!(s.selection(), range(2, 2));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(view.text, shown);
}

#[test]
fn list_projection_supplies_interpreted_ordinals_and_task_state_without_rewriting() {
    let raw = "5) [X] first\n1) second\n\n+ final";
    let s = EditorSession::open(raw);
    let projected = s
        .project(s.revision(), range(0, s.display_text().len()))
        .unwrap();
    let blocks = serde_json::to_value(projected.blocks).unwrap();
    assert_eq!(
        blocks[0]["list"],
        serde_json::json!({"depth":1,"number":5,"checked":true,"first":true})
    );
    assert_eq!(
        blocks[1]["list"],
        serde_json::json!({"depth":1,"number":6,"checked":null,"first":true})
    );
    assert_eq!(
        blocks[3]["list"],
        serde_json::json!({"depth":1,"number":null,"checked":null,"first":true})
    );
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.display_text(), "first\nsecond\n\nfinal");
}

#[test]
fn indented_loose_lists_keep_one_owner_across_continuation_and_blank_lines() {
    let raw = "  5) first\n     tail\n\n  1) next\n\n+ keep";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("first\ntail\n\nnext\n\nkeep");
    assert_eq!(s.display_text(), view.text);
    let projection = s.project(s.revision(), range(0, view.text.len())).unwrap();
    let blocks = serde_json::to_value(projection.blocks).unwrap();
    assert_eq!(
        blocks[1]["list"],
        serde_json::json!({"depth":1,"number":5,"checked":null,"first":false})
    );
    assert_eq!(blocks[3]["list"]["number"], 6);
    view.apply(
        s.paragraph_key(s.revision(), range(5, 5), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(
        s.source_text(),
        "  5) first\n  6) \n     tail\n\n  7) next\n\n+ keep"
    );
    assert_eq!(view.text, "first\n\ntail\n\nnext\n\nkeep");
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
}
