use super::*;

#[derive(Clone, Copy)]
enum Action<'a> {
    Block(BlockCommand),
    Key(ParagraphKey),
    Replace(&'a str),
}

fn apply_action(
    s: &mut EditorSession,
    selected: DisplayRange,
    action: Action<'_>,
    accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
) -> Result<ViewChange, EditorError> {
    match action {
        Action::Block(command) => s
            .block_command(s.revision(), selected, command, accept)
            .map(Option::unwrap),
        Action::Key(key) => s
            .paragraph_key(s.revision(), selected, key, accept)
            .map(Option::unwrap),
        Action::Replace(text) => {
            s.replace_action(s.revision(), selected, text, InputAction::Isolated, accept)
        }
    }
}

fn check_edit(
    raw: &str,
    shown: &str,
    selected: DisplayRange,
    action: Action<'_>,
    expected_source: Option<&str>,
    expected_display: &str,
    expected_selection: DisplayRange,
) {
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    assert_eq!(s.display_text(), shown);
    s.select_with_affinity(s.revision(), selected, Affinity::Forward)
        .unwrap();
    let revision = s.revision();
    assert!(apply_action(&mut s, selected, action, &mut |_| Err("blocked".into())).is_err());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.revision(), revision);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Forward);
    assert!(s
        .undo(s.revision(), &mut |_| panic!(
            "rejected edit has no history"
        ))
        .unwrap()
        .is_none());
    let mut accepted = 0;
    let change = apply_action(&mut s, selected, action, &mut |_| {
        accepted += 1;
        Ok(())
    })
    .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(change.selection, expected_selection);
    view.apply(change);
    assert_eq!(view.text, expected_display);
    assert_eq!(s.display_text(), expected_display);
    if let Some(source) = expected_source {
        assert_eq!(s.source_text(), source);
    }
    s.display_to_utf16(s.revision(), s.selection()).unwrap();
    assert_eq!(
        EditorSession::open(&s.source_text()).display_text(),
        expected_display
    );
    let committed = s.source_text();
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Forward);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), committed);
    assert_eq!(view.text, expected_display);
    assert_eq!(s.selection(), expected_selection);
}

#[test]
fn divider_keeps_owned_multiline_quote_prefixes_hidden() {
    check_edit(
        "> a\n> b\n> =",
        "a\nb",
        range(0, 0),
        Action::Block(BlockCommand::Divider),
        Some("> ---\n> \n> a\n> b\n> ="),
        "\u{fffc}\n\na\nb",
        range(4, 4),
    );
}

#[test]
fn divider_deletes_the_entire_selected_setext_body() {
    check_edit(
        "> a\n> b\n> =",
        "a\nb",
        range(0, 3),
        Action::Block(BlockCommand::Divider),
        Some("> ---\n> "),
        "\u{fffc}\n",
        range(4, 4),
    );
}

#[test]
fn divider_accepts_the_unicode_multiline_heading_end_caret() {
    check_edit(
        "> 猫🦊\n> e\u{301}z\n> ===",
        "猫🦊\ne\u{301}z",
        range(12, 12),
        Action::Block(BlockCommand::Divider),
        Some("> 猫🦊\n> e\u{301}z\n> ===\n> ***\n> "),
        "猫🦊\ne\u{301}z\n\u{fffc}\n",
        range(17, 17),
    );
}

#[test]
fn whole_heading_conversion_folds_its_owned_body_lines() {
    check_edit(
        "a\nb\n===",
        "a\nb",
        range(0, 3),
        Action::Block(BlockCommand::Heading(3)),
        Some("### a b"),
        "a b",
        range(0, 3),
    );
}

#[test]
fn whole_heading_conversion_preserves_literal_trailing_hashes() {
    check_edit(
        "> ab ##\n> cd ###\n> ===",
        "ab ##\ncd ###",
        range(0, 12),
        Action::Block(BlockCommand::Heading(3)),
        Some("> ### ab ## cd \\###"),
        "ab ## cd ###",
        range(0, 12),
    );
}

#[test]
fn delete_at_heading_start_preserves_the_exposed_body_space() {
    check_edit(
        "## x y",
        "x y",
        range(0, 0),
        Action::Key(ParagraphKey::Delete),
        Some("## &#32;y"),
        " y",
        range(0, 0),
    );
}

#[test]
fn delete_literal_heading_hash_preserves_the_following_body_space() {
    check_edit(
        "## # ab",
        "# ab",
        range(0, 0),
        Action::Key(ParagraphKey::Delete),
        Some("## &#32;ab"),
        " ab",
        range(0, 0),
    );
}

#[test]
fn backspace_repairs_the_surviving_literal_setext_hash() {
    check_edit(
        "#x\n=",
        "#x",
        range(2, 2),
        Action::Key(ParagraphKey::Backspace),
        Some("\\#\n="),
        "#",
        range(1, 1),
    );
}

fn check_followup(
    initial: (&str, &str, usize, ParagraphKey),
    entered: (&str, &str, usize),
    typed: (&str, &str),
) {
    let (raw, shown, at, key) = initial;
    let (source, display, caret) = entered;
    let (typed_source, typed_display) = typed;
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    s.select_with_affinity(s.revision(), range(at, at), Affinity::Forward)
        .unwrap();
    view.apply(
        s.paragraph_key(s.revision(), range(at, at), key, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(s.source_text(), source);
    assert_eq!(view.text, display);
    assert_eq!(s.selection(), range(caret, caret));
    let returned_affinity = s.affinity();
    let carried = s.active_formats();
    // The host uses the engine's returned state directly, with no selection echo.
    view.apply(
        s.replace_action(
            s.revision(),
            s.selection(),
            "!",
            InputAction::Isolated,
            &mut |_| Ok(()),
        )
        .unwrap(),
    );
    assert_eq!(s.source_text(), typed_source);
    assert_eq!(view.text, typed_display);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), source);
    assert_eq!(s.selection(), range(caret, caret));
    assert_eq!(s.affinity(), returned_affinity);
    assert_eq!(s.active_formats(), carried);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(view.text, shown);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), typed_source);
    assert_eq!(view.text, typed_display);
}

#[test]
fn quote_enter_returned_caret_types_into_its_own_bold_span() {
    check_followup(
        ("> __ab\n> cd__", "ab\ncd", 1, ParagraphKey::Enter),
        ("> __a__\n>\n> __b__\n> __cd__", "a\n\nb\ncd", 3),
        ("> __a__\n>\n> __!b__\n> __cd__", "a\n\n!b\ncd"),
    );
}

#[test]
fn setext_enter_returned_caret_types_into_its_own_bold_span() {
    check_followup(
        ("> __ab\n> cd__\n> ===", "ab\ncd", 1, ParagraphKey::Enter),
        ("> __a__\n> ===\n> __b\n> cd__", "a\nb\ncd", 2),
        ("> __a__\n> ===\n> __!b\n> cd__", "a\n!b\ncd"),
    );
}

#[test]
fn setext_delete_returned_caret_types_into_its_own_code_span() {
    check_followup(
        ("> `ab`\n> `cd`\n> ---", "ab\ncd", 3, ParagraphKey::Delete),
        ("> `ab`\n> `d`\n> ---", "ab\nd", 3),
        ("> `ab`\n> `!d`\n> ---", "ab\n!d"),
    );
}

#[test]
fn replacing_the_whole_atx_body_keeps_a_visible_space() {
    check_edit(
        "## x",
        "x",
        range(0, 1),
        Action::Replace(" "),
        Some("## &#32;"),
        " ",
        range(1, 1),
    );
}

#[test]
fn replacing_the_whole_setext_body_retires_a_dependent_underline() {
    check_edit(
        "x\n=",
        "x",
        range(0, 1),
        Action::Replace("\n"),
        Some("# \n"),
        "\n",
        range(1, 1),
    );
}

#[test]
fn divider_gives_a_surviving_lazy_body_its_necessary_quote_prefix() {
    for (selected, expected, display, caret) in [
        (
            range(3, 3),
            "> ab\n> ===\n\n> ***\n> \n> cd\n> ===",
            "ab\n\n\u{fffc}\n\ncd",
            8,
        ),
        (
            range(4, 4),
            "> ab\nc\n> ===\n> ***\n> \n> d\n> ===",
            "ab\nc\n\u{fffc}\n\nd",
            9,
        ),
        (
            range(1, 4),
            "> a\n> ===\n> ***\n> \n> d\n> ===",
            "a\n\u{fffc}\n\nd",
            6,
        ),
    ] {
        check_edit(
            "> ab\ncd\n> ===",
            "ab\ncd",
            selected,
            Action::Block(BlockCommand::Divider),
            Some(expected),
            display,
            range(caret, caret),
        );
    }
}

#[test]
fn typing_after_deleting_all_atx_bodies_keeps_the_owned_closer_hidden() {
    for key in [ParagraphKey::Backspace, ParagraphKey::Delete] {
        let raw = "> ## # ab ##\n> ## cd ###";
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new("# ab\ncd");
        s.select_with_affinity(s.revision(), range(0, 7), Affinity::Forward)
            .unwrap();
        view.apply(
            s.paragraph_key(s.revision(), range(0, 7), key, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), "> ##  ###");
        assert_eq!(view.text, "");
        view.apply(
            s.replace_action(
                s.revision(),
                s.selection(),
                "!",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
        );
        assert_eq!(s.source_text(), "> ##  ! ###");
        assert_eq!(view.text, "!");
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), "> ##  ###");
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(view.text, "# ab\ncd");
    }
}

#[test]
fn every_heading_level_maps_the_owned_crlf_body_and_preserves_unselected_neighbors() {
    let raw = "> #x ##\r\n> 猫🦊\r\n> ---\r\n\r\nneighbor  \r\n";
    let shown = "#x ##\r\n猫🦊\r\n\r\nneighbor  \r\n";
    for level in 1..=6 {
        if level == 2 {
            let mut s = EditorSession::open(raw);
            assert!(s
                .block_command(
                    s.revision(),
                    range(0, 14),
                    BlockCommand::Heading(level),
                    &mut |_| panic!("same level is a no-op")
                )
                .unwrap()
                .is_none());
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.display_text(), shown);
        } else {
            check_edit(
                raw,
                shown,
                range(0, 14),
                Action::Block(BlockCommand::Heading(level)),
                Some(&format!(
                    "> {} #x ## 猫🦊\r\n\r\nneighbor  \r\n",
                    "#".repeat(level as usize)
                )),
                "#x ## 猫🦊\r\n\r\nneighbor  \r\n",
                range(0, 13),
            );
        }
    }
}

#[test]
fn complete_heading_replacement_retires_syntax_only_when_the_new_body_needs_it() {
    for (raw, selected, heading) in [
        ("## ab", range(0, 2), "## "),
        ("> ## ab", range(0, 2), "> ## "),
        ("ab\n===", range(0, 2), "# "),
        ("> ab\n> ===", range(0, 2), "> # "),
    ] {
        for text in ["", " ", "\t", "\n", "\r\n", "X\n\nY", "X\nY"] {
            let mut s = EditorSession::open(raw);
            let mut view = ReferenceView::new("ab");
            s.select(s.revision(), selected).unwrap();
            view.apply(
                s.replace_action(
                    s.revision(),
                    selected,
                    text,
                    InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .unwrap(),
            );
            assert_eq!(view.text, text, "{raw:?}/{text:?}");
            assert_eq!(EditorSession::open(&s.source_text()).display_text(), text);
            if text == " " {
                assert_eq!(s.source_text(), format!("{heading}&#32;"));
            }
            if text == "X\nY" && raw.ends_with("===") {
                assert_eq!(
                    s.source_text(),
                    if raw.starts_with('>') {
                        "> X\nY\n> ==="
                    } else {
                        "X\nY\n==="
                    }
                );
            }
            let committed = s.source_text();
            view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), raw);
            view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), committed);
            assert_eq!(view.text, text);
        }
    }
}
