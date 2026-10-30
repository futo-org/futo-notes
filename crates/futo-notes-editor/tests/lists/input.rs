use super::*;

#[test]
fn typed_list_and_task_shortcuts_convert_only_the_trigger_and_keep_exact_undo() {
    for (raw, shown, at, expected, display) in [
        ("*body", "*body", 1, "- body", "body"),
        ("+body", "+body", 1, "- body", "body"),
        ("-body", "-body", 1, "- body", "body"),
        ("12.body", "12.body", 3, "12. body", "body"),
        ("* [x]body", "[x]body", 3, "* [x] body", "body"),
        ("* [ ]body", "[ ]body", 3, "* [ ] body", "body"),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(shown);
        s.select(s.revision(), range(at, at)).unwrap();
        let mut accepted = 0;
        view.apply(
            s.replace(s.revision(), range(at, at), " ", &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, display);
        assert_eq!(s.selection(), range(0, 0));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(at, at));
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}

#[test]
fn unsupported_typed_markers_and_raw_composition_remain_literal_and_code_is_opaque() {
    for (raw, at, expected, shown) in [
        ("1)body", 2, "&#49;) body", "1) body"),
        ("* [X]body", 3, "* \\[X] body", "[X] body"),
        ("`*body`", 1, "`* body`", "* body"),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(&s.display_text());
        s.select(s.revision(), range(at, at)).unwrap();
        view.apply(
            s.replace(s.revision(), range(at, at), " ", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, shown);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
    let mut s = EditorSession::open("");
    let mut view = ReferenceView::new("");
    s.compose(s.revision(), range(0, 0), "- ").unwrap();
    assert_eq!(s.source_text(), "");
    assert!(s
        .commit_composition(s.revision(), None, &mut |_| Err("append".into()))
        .is_err());
    assert!(s.composition().is_some());
    view.apply(
        s.commit_composition(s.revision(), None, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(s.source_text(), "&#45; ");
    assert_eq!(view.text, "- ");
    assert!(s
        .commit_composition(s.revision(), None, &mut |_| panic!("repeat"))
        .unwrap()
        .is_none());
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "");
}

#[test]
fn list_shortcuts_retain_literal_whitespace_and_task_looking_body_content() {
    for (raw, at, expected, shown) in [
        ("\\*  foo", 1, "- &#32; foo", "  foo"),
        ("\\*[x] foo", 1, "- \\[x] foo", "[x] foo"),
        ("* \\[x]  foo", 3, "* [x] &#32; foo", "  foo"),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(&s.display_text());
        s.select(s.revision(), range(at, at)).unwrap();
        view.apply(
            s.replace(s.revision(), range(at, at), " ", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(0, 0));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}

#[test]
fn shortcut_acceptance_keeps_foreign_ownership_selection_and_carried_format() {
    let raw = "2.body\n\n7. after";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("2.body\n\nafter");
    s.select_with_affinity(s.revision(), range(2, 2), Affinity::Backward)
        .unwrap();
    s.toggle_format(s.revision(), InlineFormat::Bold, &mut |_| {
        panic!("caret format")
    })
    .unwrap();
    let mut proposals = Vec::new();
    assert!(matches!(
        s.replace(s.revision(), range(2, 2), " ", &mut |edit| {
            proposals.push(edit.clone());
            Err("append".into())
        }),
        Err(EditorError::Persistence(_))
    ));
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.display_text(), view.text);
    assert_eq!(s.revision(), Revision(0));
    assert_eq!(s.selection(), range(2, 2));
    assert_eq!(s.affinity(), Affinity::Backward);
    assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
    assert_eq!(proposals.len(), 1);
    let proposed = &proposals[0];
    let mut source = raw.to_owned();
    source.replace_range(
        proposed.range.start.0..proposed.range.end.0,
        &proposed.inserted,
    );
    assert_eq!(source, "2) body\n\n7. after");
    view.apply(
        s.replace(s.revision(), range(2, 2), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), source);
    assert_eq!(view.text, "body\n\nafter");
    assert_eq!(s.selection(), range(0, 0));
    assert_eq!(s.affinity(), Affinity::Backward);
    assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
    view.apply(
        s.replace(s.revision(), s.selection(), "!", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "2) **!**&#98;ody\n\n7. after");
    assert_eq!(view.text, "!body\n\nafter");
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), source);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), range(2, 2));
    assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), source);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "2) **!**&#98;ody\n\n7. after");
}
