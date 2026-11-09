use super::*;

#[test]
fn an_existing_heading_level_is_an_exact_noop_before_any_inline_seam_repair() {
    for tail in [" ", "  ", "\\"] {
        for eol in ["\n", "\r\n"] {
            for depth in 0..=2 {
                for (level, underline) in [(1, "="), (2, "---")] {
                    let prefix = "> ".repeat(depth);
                    let raw = format!("{prefix}__a{tail}{eol}{prefix}b__{eol}{prefix}{underline}");
                    let shown = format!("a{tail}{eol}b");
                    let mut s = EditorSession::open(&raw);
                    assert_eq!(s.display_text(), shown);
                    for selected in [
                        range(0, 0),
                        range(0, shown.len()),
                        range(shown.len(), shown.len()),
                    ] {
                        s.select_with_affinity(s.revision(), selected, Affinity::Forward)
                            .unwrap();
                        assert!(s
                            .block_command(
                                s.revision(),
                                selected,
                                BlockCommand::Heading(level),
                                &mut |_| panic!("same level must not append")
                            )
                            .unwrap()
                            .is_none());
                        assert_eq!(s.source_text(), raw);
                        assert_eq!(s.revision(), Revision(0));
                        assert_eq!(s.selection(), selected);
                    }
                }
            }
        }
    }
}

#[test]
fn quote_toggle_preserves_inline_spelling_across_owned_heading_soft_lines() {
    for (raw, shown, outdented) in [
        ("> __a \n> b__\n> =", "a \nb", "__a \nb__\n="),
        ("> __a  \n> b__\n> =", "a  \nb", "__a  \nb__\n="),
        ("> __a\\\n> b__\n> =", "a\\\nb", "__a\\\nb__\n="),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(shown);
        let mut accepts = 0;
        view.apply(
            s.block_command(s.revision(), range(0, 0), BlockCommand::Quote, &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepts, 1);
        assert_eq!(s.source_text(), outdented);
        assert_eq!(view.text, shown);
        assert_eq!(EditorSession::open(outdented).display_text(), shown);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), outdented);
    }
}

#[test]
fn existing_heading_body_soft_lines_are_not_preemptive_enter_or_divider_seams() {
    let raw = "> __a  \n> b__\n> =";
    let shown = "a  \nb";
    for (key, expected, display) in [
        (ParagraphKey::Enter, "\n> __a  \n> b__\n> =", "\na  \nb"),
        (
            ParagraphKey::ShiftEnter,
            "\n> __a  \n> b__\n> =",
            "\na  \nb",
        ),
        (ParagraphKey::Backspace, "> __a  \n> b__", "a  \nb"),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(shown);
        view.apply(
            s.paragraph_key(s.revision(), range(0, 0), key, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, display);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    view.apply(
        s.block_command(
            s.revision(),
            range(0, shown.len()),
            BlockCommand::Divider,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "> ---\n> ");
    assert_eq!(view.text, "\u{fffc}\n");
}

#[test]
fn a_heading_split_keeps_its_original_crossline_suffix_and_closer() {
    let raw = "> __ab\n> cd__\n> ===";
    let expected = "> __a__\n> ===\n> __b\n> cd__";
    let mut s = EditorSession::open(raw);
    s.paragraph_key(s.revision(), range(1, 1), ParagraphKey::Enter, &mut |_| {
        Ok(())
    })
    .unwrap()
    .unwrap();
    assert_eq!(s.source_text(), expected);
    assert!(s
        .source_text()
        .ends_with(&raw[5..raw.rfind("\n> ===").unwrap()]));
    let reopened = EditorSession::open(expected);
    assert_eq!(reopened.display_text(), "a\nb\ncd");
    for selected in [range(0, 1), range(2, 3), range(4, 6)] {
        assert!(reopened
            .project(reopened.revision(), selected)
            .unwrap()
            .runs
            .iter()
            .all(|run| run.formats.contains(&InlineFormat::Bold)));
    }
}

#[test]
fn a_literal_backslash_at_a_new_inline_closer_is_protected_at_the_body_end_too() {
    for (raw, expected) in [
        ("__a\\b__", "__a&#92;__"),
        ("_a\\b_", "_a&#92;_"),
        ("~~a\\b~~", "~~a&#92;~~"),
        ("`a\\b`", "`a\\`"),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new("a\\b");
        view.apply(
            s.paragraph_key(
                s.revision(),
                range(3, 3),
                ParagraphKey::Backspace,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, "a\\");
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}

#[test]
fn typing_literal_punctuation_after_a_visible_backslash_preserves_both_scalars() {
    for (raw, expected) in [
        ("ab\\c", "ab&#92;!c"),
        ("__ab\\c__", "__ab&#92;!c__"),
        ("> __ab\\\n> cd__\n> =", "> __ab&#92;!\n> cd__\n> ="),
    ] {
        let shown = if raw.starts_with('>') {
            "ab\\\ncd"
        } else {
            "ab\\c"
        };
        let display = if raw.starts_with('>') {
            "ab\\!\ncd"
        } else {
            "ab\\!c"
        };
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(shown);
        view.apply(
            s.replace_action(
                s.revision(),
                range(3, 3),
                "!",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, display);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}

#[test]
fn whole_paragraph_quote_toggle_leaves_unchanged_inline_bodies_verbatim() {
    for (raw, shown, command, expected) in [
        (
            "> __a  \n> b__",
            "a  \nb",
            BlockCommand::Quote,
            "__a  \nb__",
        ),
        (
            "__a\\\nb__",
            "a\\\nb",
            BlockCommand::Quote,
            "> __a\\\n> b__",
        ),
        (
            "> > __a  \r\n> > b__",
            "a  \r\nb",
            BlockCommand::Quote,
            "> __a  \r\n> b__",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(shown);
        let selected = range(0, shown.len());
        s.select(s.revision(), selected).unwrap();
        view.apply(
            s.block_command(s.revision(), selected, command, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}

pub(super) fn indented_empty_quote() -> (EditorSession, ReferenceView) {
    let mut s = EditorSession::open("> > \n> ab\n> ===");
    let view = ReferenceView::new("\nab");
    s.select(s.revision(), range(0, 0)).unwrap();
    assert_eq!(s.source_text(), "> > \n> ab\n> ===");
    assert_eq!(s.selection(), range(0, 0));
    assert_eq!(s.affinity(), Affinity::Forward);
    (s, view)
}

#[test]
fn input_at_an_empty_nested_quote_caret_separates_its_lower_lazy_neighbor() {
    for os in [false, true] {
        let (mut s, mut view) = indented_empty_quote();
        let before = s.source_text();
        let mut accepts = 0;
        let change = if os {
            s.replace_os(s.revision(), s.selection(), "!", &[], &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap()
        } else {
            s.replace_action(
                s.revision(),
                s.selection(),
                "!",
                InputAction::Typing,
                &mut |_| {
                    accepts += 1;
                    Ok(())
                },
            )
            .unwrap()
        };
        assert_eq!(accepts, 1);
        view.apply(change);
        assert_eq!(s.source_text(), "> > !\n>\n> ab\n> ===");
        assert_eq!(view.text, "!\n\nab");
        assert_eq!(s.selection(), range(1, 1));
        let p = s.project(s.revision(), range(3, 5)).unwrap();
        assert!(p
            .blocks
            .iter()
            .all(|block| block.heading == 1 && block.quote_depth == 1));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), before);
        assert_eq!(view.text, "\nab");
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), "> > !\n>\n> ab\n> ===");
    }
}

#[test]
fn replacing_or_typing_among_blank_quote_body_spaces_uses_the_same_boundary() {
    for (selected, expected, display, caret) in [
        (range(0, 0), "> > ! \n>\n> ab\n> ===", "! \n\nab", 1),
        (range(1, 1), "> >  !\n>\n> ab\n> ===", " !\n\nab", 2),
        (range(0, 1), "> > !\n>\n> ab\n> ===", "!\n\nab", 1),
    ] {
        let raw = "> >  \n> ab\n> ===";
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(" \nab");
        view.apply(
            s.replace_os(s.revision(), selected, "!", &[], &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, display);
        assert_eq!(s.selection(), range(caret, caret));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}

#[test]
fn marked_empty_quote_input_keeps_raw_preview_and_protects_its_boundary_on_commit() {
    let (mut s, mut view) = indented_empty_quote();
    let before = s.source_text();
    for text in ["に", "日本"] {
        let marked = s.compose(s.revision(), range(0, 0), text).unwrap();
        assert_eq!(marked.text, text);
        assert_eq!(marked.range, range(0, 0));
        assert_eq!(s.source_text(), before);
        assert_eq!(s.revision(), Revision(0));
        assert_eq!(
            format!("{}{}", marked.text, view.text),
            format!("{text}\nab")
        );
    }
    s.cancel_composition(s.revision()).unwrap();
    assert!(s.composition().is_none());
    assert_eq!(s.source_text(), before);
    assert_eq!(s.display_text(), "\nab");
    s.compose(s.revision(), range(0, 0), "日本").unwrap();
    assert!(s
        .commit_composition(s.revision(), None, &mut |_| Err("blocked".into()))
        .is_err());
    assert_eq!(s.source_text(), before);
    assert_eq!(s.revision(), Revision(0));
    assert_eq!(s.composition().unwrap().text, "日本");
    let mut accepts = 0;
    view.apply(
        s.commit_composition(s.revision(), None, &mut |_| {
            accepts += 1;
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(s.source_text(), "> > 日本\n>\n> ab\n> ===");
    assert_eq!(view.text, "日本\n\nab");
    assert_eq!(s.selection(), range(6, 6));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), before);
    assert_eq!(view.text, "\nab");
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "> > 日本\n>\n> ab\n> ===");
}
