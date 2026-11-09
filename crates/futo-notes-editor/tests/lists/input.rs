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
        ("* \\[x]  foo", 3, "* [x]   foo", "  foo"),
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
    for composed in [false, true] {
        for (raw, display, at, converted, shown, caret, followup, followup_display) in [
            (
                "2.body\n\n7. after",
                "2.body\n\nafter",
                2,
                "2) body\n\n7. after",
                "body\n\nafter",
                0,
                "2) **!**&#98;ody\n\n7. after",
                "!body\n\nafter",
            ),
            (
                "9. before\n\n2\\.\n\n7) after",
                "before\n\n2.\n\nafter",
                10,
                "9. before\n\n2) \n\n7) after",
                "before\n\n\n\nafter",
                8,
                "9. before\n\n2) **!**\n\n7) after",
                "before\n\n!\n\nafter",
            ),
            (
                "2.body\n\n\n7. after",
                "2.body\n\n\nafter",
                2,
                "2) body\n\n\n7. after",
                "body\n\n\nafter",
                0,
                "2) **!**&#98;ody\n\n\n7. after",
                "!body\n\n\nafter",
            ),
            (
                "9. before\n\n\n2\\.\n\n\n7) after",
                "before\n\n\n2.\n\n\nafter",
                11,
                "9. before\n\n\n2) \n\n\n7) after",
                "before\n\n\n\n\n\nafter",
                9,
                "9. before\n\n\n2) **!**\n\n\n7) after",
                "before\n\n\n!\n\n\nafter",
            ),
            (
                "999. before\n\n\n1000.body\n\n\n7. after",
                "before\n\n\n1000.body\n\n\nafter",
                14,
                "999. before\n\n\n1000. body\n\n\n7. after",
                "before\n\n\nbody\n\n\nafter",
                9,
                "999. before\n\n\n1000. **!**&#98;ody\n\n\n7. after",
                "before\n\n\n!body\n\n\nafter",
            ),
        ] {
            let mut s = EditorSession::open(raw);
            let mut view = ReferenceView::new(display);
            s.select_with_affinity(s.revision(), range(at, at), Affinity::Backward)
                .unwrap();
            s.toggle_format(s.revision(), InlineFormat::Bold, &mut |_| {
                panic!("caret format")
            })
            .unwrap();
            if composed {
                s.compose(s.revision(), range(at, at), "").unwrap();
            }
            let marked = s.composition().cloned();
            let mut proposals = Vec::new();
            assert!(matches!(
                s.replace(s.revision(), range(at, at), " ", &mut |edit| {
                    proposals.push(edit.clone());
                    Err("append".into())
                }),
                Err(EditorError::Persistence(_))
            ));
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.display_text(), view.text);
            assert_eq!(s.revision(), Revision(0));
            assert_eq!(s.composition(), marked.as_ref());
            assert_eq!(s.selection(), range(at, at));
            assert_eq!(s.affinity(), Affinity::Backward);
            assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
            assert_eq!(proposals.len(), 1);
            let proposed = &proposals[0];
            let mut source = raw.to_owned();
            source.replace_range(
                proposed.range.start.0..proposed.range.end.0,
                &proposed.inserted,
            );
            assert_eq!(source, converted);
            view.apply(
                s.replace(s.revision(), range(at, at), " ", &mut |_| Ok(()))
                    .unwrap(),
            );
            assert_eq!(s.source_text(), source);
            assert_eq!(view.text, shown);
            assert_eq!(s.selection(), range(caret, caret));
            assert_eq!(s.affinity(), Affinity::Backward);
            assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
            view.apply(
                s.replace(s.revision(), s.selection(), "!", &mut |_| Ok(()))
                    .unwrap(),
            );
            assert_eq!(s.source_text(), followup);
            assert_eq!(view.text, followup_display);
            view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), source);
            view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.selection(), range(at, at));
            assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
            view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), source);
            view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), followup);
        }
    }
}

/// Types one character at a time at the current selection, as the Android
/// text-first shell does for hardware keys and `adb shell input text`.
pub(crate) fn type_chars(s: &mut EditorSession, view: &mut ReferenceView, text: &str) {
    for ch in text.chars() {
        let change = s
            .replace_action(
                s.revision(),
                s.selection(),
                &ch.to_string(),
                InputAction::Typing,
                &mut |_| Ok(()),
            )
            .unwrap_or_else(|error| panic!("{ch:?} refused in {:?}: {error:?}", s.source_text()));
        view.apply(change);
    }
}

/// Opens `raw` and presses Enter at its end.
pub(crate) fn after_enter(raw: &str) -> (EditorSession, ReferenceView) {
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(&s.display_text());
    let end = range(view.text.len(), view.text.len());
    s.select(s.revision(), end).unwrap();
    view.apply(
        s.paragraph_key(s.revision(), end, ParagraphKey::Enter, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    (s, view)
}

#[test]
fn bullet_and_task_markers_typed_under_a_paragraph_start_a_list_item() {
    for (typed, expected, display) in [
        ("- apples", "para\n\n- apples", "para\n\napples"),
        ("* x", "para\n\n- x", "para\n\nx"),
        ("+ x", "para\n\n- x", "para\n\nx"),
        ("- [ ] x", "para\n\n- [ ] x", "para\n\nx"),
        ("1. x", "para\n\n1. x", "para\n\nx"),
    ] {
        let (mut s, mut view) = after_enter("para");
        type_chars(&mut s, &mut view, typed);
        assert_eq!(s.source_text(), expected, "{typed:?}");
        assert_eq!(view.text, display, "{typed:?}");
    }
    // The triggering space is one Undo step back to the typed literal marker.
    let (mut s, mut view) = after_enter("para");
    type_chars(&mut s, &mut view, "- ");
    assert_eq!(s.source_text(), "para\n\n- ");
    assert_eq!(view.text, "para\n\n");
    assert_eq!(s.selection(), range(6, 6));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "para\n&#45;");
    assert_eq!(view.text, "para\n-");
    assert_eq!(s.selection(), range(6, 6));
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "para\n\n- ");
    // A keyboard committing the marker as one string does the same.
    let (mut s, mut view) = after_enter("para");
    view.apply(
        s.replace_action(
            s.revision(),
            s.selection(),
            "- ",
            InputAction::Typing,
            &mut |_| Ok(()),
        )
        .unwrap(),
    );
    assert_eq!(s.source_text(), "para\n\n- ");
    assert_eq!(view.text, "para\n\n");
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "para\n");
    assert_eq!(s.selection(), range(5, 5));
}

#[test]
fn an_indented_star_typed_on_a_blank_line_stays_visible_text() {
    let mut s = EditorSession::open("\n");
    let mut view = ReferenceView::new("\n");
    s.select(s.revision(), range(1, 1)).unwrap();
    type_chars(&mut s, &mut view, " *]");
    assert_eq!(s.source_text(), "\n&#32;&#42;]");
    assert_eq!(view.text, "\n *]");
    assert_eq!(s.selection(), range(4, 4));
}

#[test]
fn a_list_marker_typed_into_an_empty_item_changes_its_kind() {
    for (raw, typed, expected, display) in [
        (
            "- [ ] a\n- [ ] ",
            "- [ ] spinach",
            "- [ ] a\n- [ ] spinach",
            "a\nspinach",
        ),
        (
            "- [ ] a\n- [ ] ",
            "- [x] beta",
            "- [ ] a\n- [x] beta",
            "a\nbeta",
        ),
        ("- [ ] a\n- [ ] ", "- plain", "- [ ] a\n- plain", "a\nplain"),
        ("- a\n- ", "1. x", "- a\n1. x", "a\nx"),
        ("- a\n- ", "- [ ] x", "- a\n- [ ] x", "a\nx"),
        ("- a\n- ", "* x", "- a\n- x", "a\nx"),
        ("1. a\n2. ", "7. x", "1. a\n2. x", "a\nx"),
    ] {
        let label = format!("{raw:?} + {typed:?}");
        // Typed one character at a time.
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(&s.display_text());
        let end = range(view.text.len(), view.text.len());
        s.select(s.revision(), end).unwrap();
        type_chars(&mut s, &mut view, typed);
        assert_eq!(s.source_text(), expected, "typed {label}");
        assert_eq!(view.text, display, "typed {label}");
        // Committed as one string: one Undo returns to the empty item.
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(&s.display_text());
        s.select(s.revision(), end).unwrap();
        view.apply(
            s.replace_action(s.revision(), end, typed, InputAction::Typing, &mut |_| {
                Ok(())
            })
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "committed {label}");
        assert_eq!(view.text, display, "committed {label}");
        assert_eq!(
            s.selection(),
            range(display.len(), display.len()),
            "{label}"
        );
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw, "undo {label}");
        assert_eq!(s.selection(), end, "undo {label}");
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected, "redo {label}");
    }
}

#[test]
fn a_list_marker_pasted_into_an_empty_item_matches_typing_it() {
    for (raw, pasted, expected) in [
        ("- [ ] a\n- [ ] ", "- [ ] spinach", "- [ ] a\n- [ ] spinach"),
        ("- [ ] a\n- [ ] ", "- [x] beta", "- [ ] a\n- [x] beta"),
        ("- a\n- ", "1. x", "- a\n1. x"),
    ] {
        let mut s = EditorSession::open(raw);
        let end = range(s.display_text().len(), s.display_text().len());
        s.select(s.revision(), end).unwrap();
        s.paste_markdown(s.revision(), end, pasted, &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(s.source_text(), expected, "{raw:?} + {pasted:?}");
    }
}
