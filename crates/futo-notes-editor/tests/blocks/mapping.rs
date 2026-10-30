use super::seams::indented_empty_quote;
use super::*;

#[test]
fn the_baseline_qualified_plain_code_carry_also_accepts_the_next_character() {
    let mut s = EditorSession::open("`ab`\n`cd`");
    let mut view = ReferenceView::new("ab\ncd");
    s.select_with_affinity(s.revision(), range(3, 3), Affinity::Forward)
        .unwrap();
    view.apply(
        s.paragraph_key(s.revision(), range(3, 3), ParagraphKey::Delete, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "`ab`\n`d`");
    assert_eq!(s.selection(), range(3, 3));
    assert_eq!(s.affinity(), Affinity::Backward);
    assert_eq!(s.active_formats(), vec![InlineFormat::Code]);
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
    assert_eq!(s.source_text(), "`ab`\n`!d`");
    assert_eq!(view.text, "ab\n!d");
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "`ab`\n`d`");
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "`ab`\n`cd`");
}

#[test]
fn unchanged_whole_field_os_selection_is_separate_from_the_marked_commit_history() {
    let mut s = EditorSession::open("ab");
    s.compose(s.revision(), range(0, 0), "!").unwrap();
    s.replace_os(s.revision(), range(0, 3), "!ab", &[], &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(s.source_text(), "!ab");
    assert_eq!(s.selection(), range(3, 3));
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), "ab");
    s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), "!ab");
    assert_eq!(s.selection(), range(1, 1));
}

#[test]
fn whole_field_input_before_a_distant_marked_edit_window_keeps_its_prefix_target() {
    let raw = "first\n\nbefore\n\n> > \n> ab\n> ===";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("first\n\nbefore\n\n\nab");
    s.compose(s.revision(), range(15, 15), "!").unwrap();
    view.apply(
        s.replace_os(
            s.revision(),
            range(0, 19),
            "first\n\nbefore\n\n!\nAC",
            &[],
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "first\n\nbefore\n\n> > !\n>\n> AC\n> ===");
    assert_eq!(view.text, "first\n\nbefore\n\n!\n\nAC");
    assert_eq!(s.selection(), range(20, 20));
}

#[test]
fn an_earlier_command_keeps_its_target_outside_the_distant_marked_edit_window() {
    let raw = "one\n\ntwo\n\nthree\n\n> > \n> ab\n> ===";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("one\n\ntwo\n\nthree\n\n\nab");
    s.compose(s.revision(), range(17, 17), "!").unwrap();
    view.apply(
        s.block_command(
            s.revision(),
            range(0, 0),
            BlockCommand::Heading(3),
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(
        s.source_text(),
        "### one\n\ntwo\n\nthree\n\n> > !\n>\n> ab\n> ==="
    );
    assert_eq!(view.text, "one\n\ntwo\n\nthree\n\n!\n\nab");
    assert_eq!(s.selection(), range(0, 0));
}

#[test]
fn os_mapping_preserves_unicode_entities_crlf_and_unchanged_text_beyond_its_edit_window() {
    for (raw, shown, text, expected, display, caret) in [
        (
            "> >  \n> ab\n> ===",
            " \nab",
            "! \nAC",
            "> > ! \n>\n> AC\n> ===",
            "! \n\nAC",
            6,
        ),
        (
            "> > \n> 猫🦊\n> ===",
            "\n猫🦊",
            "!\n犬🐈",
            "> > !\n>\n> 犬🐈\n> ===",
            "!\n\n犬🐈",
            6,
        ),
        (
            "> > \n> a&amp;b\n> ===",
            "\na&b",
            "!\nA&B",
            "> > !\n>\n> A&amp;B\n> ===",
            "!\n\nA&B",
            6,
        ),
        (
            "> > \n> a&NotEqualTilde;b\n> ===",
            "\na≂\u{338}b",
            "!\nA≂\u{338}B",
            "> > !\n>\n> A&NotEqualTilde;B\n> ===",
            "!\n\nA≂\u{338}B",
            7,
        ),
        (
            "> > \r\n> ab\r\n> ===",
            "\r\nab",
            "!\r\nAC",
            "> > !\r\n>\n> AC\r\n> ===",
            "!\r\n\nAC",
            6,
        ),
        (
            "before\n\n> > \n> ab\n> ===\n\ntail",
            "before\n\n\nab\n\ntail",
            "before\n\n!\nab\n\ntail",
            "before\n\n> > !\n>\n> ab\n> ===\n\ntail",
            "before\n\n!\n\nab\n\ntail",
            19,
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(shown);
        let selected = DisplayUtf16Range {
            start: DisplayUtf16Offset(0),
            end: DisplayUtf16Offset(shown.encode_utf16().count()),
        };
        let mut accepts = 0;
        view.apply(
            s.replace_os_utf16(
                s.revision(),
                selected,
                &text.encode_utf16().collect::<Vec<_>>(),
                &[],
                &mut |_| {
                    accepts += 1;
                    Ok(())
                },
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepts, 1);
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, display);
        assert_eq!(s.selection(), range(display.len(), display.len()));
        assert_eq!(
            s.display_to_utf16(s.revision(), s.selection())
                .unwrap()
                .end
                .0,
            caret
        );
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(view.text, shown);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        assert_eq!(s.selection(), range(display.len(), display.len()));
    }
}

#[test]
fn provisional_targets_inside_inserted_text_and_later_commands_keep_their_identity() {
    let (mut s, mut view) = indented_empty_quote();
    s.compose(s.revision(), range(0, 0), "日本").unwrap();
    view.apply(
        s.replace_os(s.revision(), range(0, 6), "猫", &[], &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(s.source_text(), "> > 猫\n>\n> ab\n> ===");
    assert_eq!(view.text, "猫\n\nab");
    assert_eq!(s.selection(), range(3, 3));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "> > 日本\n>\n> ab\n> ===");
    let (mut s, mut view) = indented_empty_quote();
    s.compose(s.revision(), range(0, 0), "!").unwrap();
    view.apply(
        s.block_command(
            s.revision(),
            range(2, 4),
            BlockCommand::Heading(3),
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "> > !\n>\n> ### ab");
    assert_eq!(view.text, "!\n\nab");
}

#[test]
fn sequential_input_maps_the_lower_heading_through_the_new_quote_separator() {
    for lower_first in [false, true] {
        let (mut s, mut view) = indented_empty_quote();
        if lower_first {
            view.apply(
                s.replace_action(
                    s.revision(),
                    range(1, 3),
                    "AC",
                    InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .unwrap(),
            );
            assert_eq!(s.source_text(), "> > \n> AC\n> ===");
            assert_eq!(view.text, "\nAC");
        }
        view.apply(
            s.replace_action(
                s.revision(),
                range(0, 0),
                "!",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
        );
        assert_eq!(view.text, if lower_first { "!\n\nAC" } else { "!\n\nab" });
        assert_eq!(
            s.source_at(s.revision(), DisplayOffset(3), Affinity::Forward)
                .unwrap(),
            SourceOffset(10)
        );
        assert_eq!(
            s.source_at(s.revision(), DisplayOffset(5), Affinity::Backward)
                .unwrap(),
            SourceOffset(12)
        );
        if !lower_first {
            view.apply(
                s.replace_action(
                    s.revision(),
                    range(3, 5),
                    "AC",
                    InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .unwrap(),
            );
            assert_eq!(s.selection(), range(5, 5));
        }
        assert_eq!(s.source_text(), "> > !\n>\n> AC\n> ===");
        assert_eq!(view.text, "!\n\nAC");
        let p = s.project(s.revision(), range(3, 5)).unwrap();
        assert!(p
            .blocks
            .iter()
            .all(|b| b.heading == 1 && b.quote_depth == 1));
    }
}

#[test]
fn a_batch_maps_same_body_spaces_and_later_heading_targets_independently() {
    let mut control = EditorSession::open("> >   \n> ab\n> ===");
    control
        .replace_action(
            control.revision(),
            range(0, 1),
            "!",
            InputAction::Isolated,
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(control.source_text(), "> > ! \n>\n> ab\n> ===");
    assert_eq!(
        control
            .source_at(control.revision(), DisplayOffset(1), Affinity::Forward)
            .unwrap(),
        SourceOffset(5)
    );
    control
        .replace_action(
            control.revision(),
            range(1, 2),
            "?",
            InputAction::Isolated,
            &mut |_| Ok(()),
        )
        .unwrap();
    control
        .replace_action(
            control.revision(),
            range(4, 6),
            "AC",
            InputAction::Isolated,
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(control.source_text(), "> > !?\n>\n> AC\n> ===");
    let mut s = EditorSession::open("> >   \n> ab\n> ===");
    let mut view = ReferenceView::new("  \nab");
    let mut accepts = 0;
    view.apply(
        s.replace_many(
            s.revision(),
            &[
                DisplayReplacement {
                    range: range(0, 1),
                    inserted: "!".into(),
                },
                DisplayReplacement {
                    range: range(1, 2),
                    inserted: "?".into(),
                },
                DisplayReplacement {
                    range: range(3, 5),
                    inserted: "AC".into(),
                },
            ],
            &mut |_| {
                accepts += 1;
                Ok(())
            },
        )
        .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(s.source_text(), "> > !?\n>\n> AC\n> ===");
    assert_eq!(view.text, "!?\n\nAC");
    assert_eq!(s.selection(), range(6, 6));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "> >   \n> ab\n> ===");
    assert_eq!(view.text, "  \nab");
}

#[test]
fn whole_display_os_input_maps_its_unchanged_trailing_heading_caret() {
    let (mut s, mut view) = indented_empty_quote();
    view.apply(
        s.replace_os(s.revision(), range(0, 3), "!\nab", &[], &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(s.source_text(), "> > !\n>\n> ab\n> ===");
    assert_eq!(view.text, "!\n\nab");
    assert_eq!(s.selection(), range(5, 5));
    assert_eq!(
        s.display_to_utf16(s.revision(), s.selection())
            .unwrap()
            .end
            .0,
        5
    );
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(view.text, "\nab");
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.selection(), range(5, 5));
}

#[test]
fn a_multi_run_os_replacement_maps_later_targets_past_the_quote_separator() {
    let (mut s, mut view) = indented_empty_quote();
    let before = s.source_text();
    let mut accepts = 0;
    view.apply(
        s.replace_os(s.revision(), range(0, 3), "!\nAC", &[], &mut |_| {
            accepts += 1;
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(s.source_text(), "> > !\n>\n> AC\n> ===");
    assert_eq!(view.text, "!\n\nAC");
    assert_eq!(s.selection(), range(5, 5));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), before);
    assert_eq!(view.text, "\nab");
}

#[test]
fn provisional_whole_field_mapping_retains_the_structural_unchanged_run() {
    let committed = "> > !\n>\n> ab\n> ===";
    let mut whole = EditorSession::open(committed);
    assert_eq!(
        whole.replace_os(
            whole.revision(),
            range(0, 5),
            "!\nAC",
            &[],
            &mut |_| panic!("unrepresentable source must not append")
        ),
        Err(EditorError::UnrepresentableFormat)
    );
    assert_eq!(whole.source_text(), committed);
    let mut changed_only = EditorSession::open(committed);
    changed_only
        .replace_os(changed_only.revision(), range(3, 5), "AC", &[], &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(changed_only.source_text(), "> > !\n>\n> AC\n> ===");
    let (mut pending, _) = indented_empty_quote();
    pending
        .compose(pending.revision(), range(0, 0), "!")
        .unwrap();
    pending
        .replace_os(pending.revision(), range(2, 4), "AC", &[], &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(pending.source_text(), "> > !\n>\n> AC\n> ===");
    assert_eq!(pending.selection(), range(5, 5));
}

#[test]
fn os_input_during_marking_maps_provisional_targets_after_the_protected_separator() {
    let (mut s, mut view) = indented_empty_quote();
    let before = s.source_text();
    s.compose(s.revision(), range(0, 0), "!").unwrap();
    assert_eq!(s.source_text(), before);
    let mut accepts = 0;
    view.apply(
        s.replace_os(s.revision(), range(0, 4), "!\nAC", &[], &mut |_| {
            accepts += 1;
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(s.source_text(), "> > !\n>\n> AC\n> ===");
    assert_eq!(view.text, "!\n\nAC");
    assert_eq!(s.selection(), range(5, 5));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "> > !\n>\n> ab\n> ===");
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), before);
}
