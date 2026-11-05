mod common;
use common::ReferenceView;
use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession, Revision};
fn range(a: usize, z: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(z),
    }
}
#[test]
fn deleting_the_end_of_a_formatted_selection_carries_its_style() {
    let mut session = EditorSession::open("a __bold__ tail");
    let mut view = ReferenceView::new("a bold tail");
    session.select(Revision(0), range(4, 6)).unwrap();
    view.apply(
        session
            .replace(Revision(0), range(4, 6), "", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), "a __bo__ tail");
    assert_eq!(view.text, "a bo tail");
    view.apply(
        session
            .replace(Revision(1), range(4, 4), "X", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), "a __boX__ tail");
    assert_eq!(view.text, "a boX tail");
    assert_eq!(session.selection(), range(5, 5));
}
#[test]
fn enter_uses_the_platform_range_and_undo_removes_one_newline() {
    use futo_notes_editor::ParagraphKey;
    let mut session = EditorSession::open("ab\r\nuntouched\r\n");
    let mut view = ReferenceView::new("ab\r\nuntouched\r\n");
    session.select(Revision(0), range(10, 10)).unwrap();
    view.apply(
        session
            .paragraph_key(Revision(0), range(1, 1), ParagraphKey::Enter, &mut |_| {
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "a\nb\r\nuntouched\r\n");
    assert_eq!(view.text, "a\nb\r\nuntouched\r\n");
    assert_eq!(session.selection(), range(2, 2));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "ab\r\nuntouched\r\n");
    assert_eq!(session.selection(), range(10, 10));
}

#[test]
fn enter_start_middle_end_repeated_empty_and_shift_have_literal_newlines() {
    use futo_notes_editor::ParagraphKey;
    for key in [ParagraphKey::Enter, ParagraphKey::ShiftEnter] {
        for (opening, at, expected, twice) in [
            ("ab", 0, "\nab", "\n\nab"),
            ("ab", 1, "a\nb", "a\n\nb"),
            ("ab", 2, "ab\n", "ab\n\n"),
            ("", 0, "\n", "\n\n"),
            ("a\nb", 2, "a\n\nb", "a\n\n\nb"),
        ] {
            let mut s = EditorSession::open(opening);
            let mut v = ReferenceView::new(opening);
            v.apply(
                s.paragraph_key(s.revision(), range(at, at), key, &mut |_| Ok(()))
                    .unwrap()
                    .unwrap(),
            );
            assert_eq!(s.source_text(), expected);
            assert_eq!(v.text, expected);
            assert_eq!(s.selection(), range(at + 1, at + 1));
            v.apply(
                s.paragraph_key(s.revision(), s.selection(), key, &mut |_| Ok(()))
                    .unwrap()
                    .unwrap(),
            );
            assert_eq!(s.source_text(), twice);
            assert_eq!(v.text, twice);
            v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), expected);
            v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), opening);
        }
    }
}

#[test]
fn bold_carries_across_enter_and_an_empty_line_without_losing_undo_bytes() {
    use futo_notes_editor::{InlineFormat, ParagraphKey};
    let mut s = EditorSession::open("__ab__\r\nuntouched\r\n");
    let mut v = ReferenceView::new("ab\r\nuntouched\r\n");
    s.select(Revision(0), range(1, 1)).unwrap();
    v.apply(
        s.paragraph_key(s.revision(), range(1, 1), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "__a\nb__\r\nuntouched\r\n");
    assert_eq!(v.text, "a\nb\r\nuntouched\r\n");
    assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
    v.apply(
        s.paragraph_key(s.revision(), range(2, 2), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "__a__\n\n__b__\r\nuntouched\r\n");
    assert_eq!(v.text, "a\n\nb\r\nuntouched\r\n");
    assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
    v.apply(
        s.replace(s.revision(), range(3, 3), "X", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "__a__\n\n__Xb__\r\nuntouched\r\n");
    assert_eq!(v.text, "a\n\nXb\r\nuntouched\r\n");
}

#[test]
fn directional_deletion_removes_one_grapheme_or_linebreak_and_undoes_one_action() {
    use futo_notes_editor::ParagraphKey::{Backspace, Delete};
    for (opening, display, at, key, source, shown, caret) in [
        (
            "a😀e\u{301}b",
            "a😀e\u{301}b",
            5,
            Backspace,
            "ae\u{301}b",
            "ae\u{301}b",
            1,
        ),
        ("a😀e\u{301}b", "a😀e\u{301}b", 5, Delete, "a😀b", "a😀b", 5),
        (
            "a\r\nb\r\n",
            "a\r\nb\r\n",
            3,
            Backspace,
            "ab\r\n",
            "ab\r\n",
            1,
        ),
        ("a\r\nb\r\n", "a\r\nb\r\n", 1, Delete, "ab\r\n", "ab\r\n", 1),
        ("a\n\nb", "a\n\nb", 3, Backspace, "a\nb", "a\nb", 2),
        ("a\n\nb", "a\n\nb", 1, Delete, "a\nb", "a\nb", 1),
        ("__ab__", "ab", 2, Backspace, "__a__", "a", 1),
        ("__ab__", "ab", 0, Delete, "__b__", "b", 0),
    ] {
        let mut s = EditorSession::open(opening);
        let mut v = ReferenceView::new(display);
        s.select(s.revision(), range(at, at)).unwrap();
        v.apply(
            s.paragraph_key(s.revision(), range(at, at), key, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), source, "{opening:?} {key:?}");
        assert_eq!(v.text, shown);
        assert_eq!(s.selection(), range(caret, caret));
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), opening);
        assert_eq!(v.text, display);
        assert_eq!(s.selection(), range(at, at));
        v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), source);
        assert_eq!(v.text, shown);
    }
}

#[test]
fn keys_reject_invalid_ranges_and_failed_acceptance_without_mutating_history() {
    use futo_notes_editor::{EditorError, ParagraphKey};
    let mut s = EditorSession::open("😀\r\n");
    for key in [
        ParagraphKey::Enter,
        ParagraphKey::ShiftEnter,
        ParagraphKey::Backspace,
        ParagraphKey::Delete,
    ] {
        let mut calls = 0;
        assert_eq!(
            s.paragraph_key(Revision(0), range(1, 1), key, &mut |_| {
                calls += 1;
                Ok(())
            }),
            Err(EditorError::InvalidRange)
        );
        assert_eq!(calls, 0);
        assert!(matches!(
            s.paragraph_key(Revision(0), range(4, 4), key, &mut |_| Err("full".into())),
            Err(EditorError::Persistence(_))
        ));
        assert_eq!(s.source_text(), "😀\r\n");
        assert_eq!(s.selection(), range(0, 0));
        assert!(s.undo(Revision(0), &mut |_| Ok(())).unwrap().is_none());
    }
    let mut calls = 0;
    assert!(s
        .paragraph_key(
            Revision(0),
            range(0, 0),
            ParagraphKey::Backspace,
            &mut |_| {
                calls += 1;
                Ok(())
            }
        )
        .unwrap()
        .is_none());
    assert!(s
        .paragraph_key(Revision(0), range(6, 6), ParagraphKey::Delete, &mut |_| {
            calls += 1;
            Ok(())
        })
        .unwrap()
        .is_none());
    assert_eq!(calls, 0);
    assert_eq!(s.revision(), Revision(0));
}

#[test]
fn deleting_a_whole_formatted_selection_retains_style_and_exact_history() {
    use futo_notes_editor::{InlineFormat, ParagraphKey};
    for key in [ParagraphKey::Backspace, ParagraphKey::Delete] {
        let mut s = EditorSession::open("__bold__ tail\r\n");
        let mut v = ReferenceView::new("bold tail\r\n");
        s.select(s.revision(), range(0, 4)).unwrap();
        v.apply(
            s.paragraph_key(s.revision(), range(0, 4), key, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), " tail\r\n");
        assert_eq!(v.text, " tail\r\n");
        assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
        v.apply(
            s.replace(s.revision(), range(0, 0), "X", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(s.source_text(), "**X** tail\r\n");
        assert_eq!(v.text, "X tail\r\n");
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), " tail\r\n");
        assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), "__bold__ tail\r\n");
        assert_eq!(s.selection(), range(0, 4));
        assert_eq!(v.text, "bold tail\r\n");
    }
}

#[test]
fn joining_formatted_paragraph_lines_preserves_both_spans_and_exact_action_undo() {
    use futo_notes_editor::ParagraphKey;
    for (opening, display, at, key, expected, shown) in [
        (
            "__a__\n\n__b__",
            "a\n\nb",
            2,
            ParagraphKey::Delete,
            "__a__\n__b__",
            "a\nb",
        ),
        (
            "__a__\n__b__",
            "a\nb",
            2,
            ParagraphKey::Backspace,
            "__ab__",
            "ab",
        ),
    ] {
        let mut s = EditorSession::open(opening);
        let mut v = ReferenceView::new(display);
        v.apply(
            s.paragraph_key(s.revision(), range(at, at), key, &mut |_| Ok(()))
                .unwrap_or_else(|e| panic!("{opening:?} {key:?}: {e:?}"))
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(v.text, shown);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), opening);
        assert_eq!(v.text, display);
    }
}

#[test]
fn a_nonbreaking_space_line_is_content_and_keeps_its_existing_inline_run() {
    use futo_notes_editor::ParagraphKey;
    let mut s = EditorSession::open("__a\n\u{00a0}b__");
    let mut v = ReferenceView::new("a\n\u{00a0}b");
    v.apply(
        s.paragraph_key(s.revision(), range(4, 4), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "__a\n\u{00a0}\nb__");
    assert_eq!(v.text, "a\n\u{00a0}\nb");
}

#[test]
fn a_caret_between_cr_and_lf_acts_at_the_line_end_and_never_refuses() {
    use futo_notes_editor::ParagraphKey;
    let keys = [
        ParagraphKey::Enter,
        ParagraphKey::ShiftEnter,
        ParagraphKey::Backspace,
        ParagraphKey::Delete,
        ParagraphKey::Tab,
        ParagraphKey::ShiftTab,
    ];
    for opening in [
        "ab\r\ncd",
        "**ab**\r\ncd",
        "- ab\r\n- cd",
        "1. ab\r\n   cd",
        "> ab\r\n> cd",
        "# ab\r\ncd",
        "```\r\nab\r\ncd\r\n```",
        "| a | b |\r\n| - | - |\r\n| c | d |\r\n",
    ] {
        let display = EditorSession::open(opening).display_text();
        let inside = display.find("\r\n").unwrap() + 1;
        // The same input with the caret before the CR is the expected result.
        let before = |act: &dyn Fn(&mut EditorSession, DisplayRange) -> bool| {
            let mut s = EditorSession::open(opening);
            let acted = act(&mut s, range(inside - 1, inside - 1));
            (acted, s.source_text(), s.selection())
        };
        let mut s = EditorSession::open(opening);
        assert_eq!(
            s.select(s.revision(), range(inside, inside))
                .unwrap()
                .selection,
            range(inside - 1, inside - 1),
            "{opening:?}"
        );
        let typed =
            |s: &mut EditorSession, at| s.replace(s.revision(), at, "x", &mut |_| Ok(())).is_ok();
        let mut s = EditorSession::open(opening);
        assert!(typed(&mut s, range(inside, inside)), "{opening:?} typing");
        assert_eq!(
            (true, s.source_text(), s.selection()),
            before(&typed),
            "{opening:?} typing"
        );
        let acts: [(&str, fn(&mut EditorSession, DisplayRange) -> bool); 2] = [
            ("compose", |s, at| {
                s.compose(s.revision(), at, "x").is_ok()
                    && s.commit_composition(s.revision(), None, &mut |_| Ok(()))
                        .is_ok()
            }),
            ("paste", |s, at| {
                s.paste_markdown(s.revision(), at, "x", &mut |_| Ok(()))
                    .is_ok()
            }),
        ];
        for (name, act) in acts {
            // A table's row edge is outside every cell, where paste is refused
            // whatever the line ending (tables.md).
            if name == "paste" && opening.starts_with('|') {
                continue;
            }
            let mut s = EditorSession::open(opening);
            assert!(act(&mut s, range(inside, inside)), "{opening:?} {name}");
            assert_eq!(
                (true, s.source_text(), s.selection()),
                before(&act),
                "{opening:?} {name}"
            );
        }
        for key in keys {
            let press = |s: &mut EditorSession, at| {
                s.paragraph_key(s.revision(), at, key, &mut |_| Ok(()))
                    .is_ok()
            };
            let mut s = EditorSession::open(opening);
            assert!(press(&mut s, range(inside, inside)), "{opening:?} {key:?}");
            assert_eq!(
                (true, s.source_text(), s.selection()),
                before(&press),
                "{opening:?} {key:?}"
            );
        }
    }
}
