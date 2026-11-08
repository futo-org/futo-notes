use super::*;

#[test]
fn toolbar_formats_cover_the_whole_selection_and_keep_carried_caret_formats() {
    use futo_notes_editor::InlineFormat;
    let mut s = EditorSession::open("**bold** plain");
    s.select(s.revision(), range(0, 10)).unwrap();
    assert!(s.toolbar_state().formats.is_empty());
    s.select(s.revision(), range(0, 4)).unwrap();
    assert_eq!(s.toolbar_state().formats, vec![InlineFormat::Bold]);
    s.select(s.revision(), range(10, 10)).unwrap();
    s.toggle_format(s.revision(), InlineFormat::Italic, &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.toolbar_state().formats, vec![InlineFormat::Italic]);
}

#[test]
fn toolbar_selection_reports_common_blocks_refusals_and_history() {
    let mut s = EditorSession::open("# heading\n\nplain");
    s.select(s.revision(), range(0, s.display_text().len()))
        .unwrap();
    assert_eq!(s.toolbar_state().heading, None);
    assert!(s.toolbar_state().mixed);
    assert!(!s.toolbar_state().can_indent);
    assert!(!s.toolbar_state().can_outdent);
    assert!(!s.toolbar_state().can_undo);
    assert!(!s.toolbar_state().can_redo);
    s.replace(s.revision(), range(0, 0), "x", &mut |_| Ok(()))
        .unwrap();
    assert!(s.toolbar_state().can_undo);
    s.undo(s.revision(), &mut |_| Ok(())).unwrap();
    assert!(s.toolbar_state().can_redo);
    let code = EditorSession::open("```\ncode\n```");
    assert!(code.toolbar_state().code);
    assert!(!code.toolbar_state().inline_allowed);
}

#[test]
fn toolbar_container_eligibility_uses_the_engines_retained_attribution() {
    let mut list = EditorSession::open("- first\n- second");
    assert!(!list.toolbar_state().can_indent);
    assert!(list.toolbar_state().can_outdent);
    list.select(list.revision(), range(6, 6)).unwrap();
    assert!(list.toolbar_state().can_indent);
    assert!(list.toolbar_state().can_outdent);
    let quoted = EditorSession::open("> quote");
    assert!(quoted.toolbar_state().can_indent);
    assert!(quoted.toolbar_state().can_outdent);
    let code = EditorSession::open("```\n  indented\n```");
    assert!(code.toolbar_state().can_indent);
    assert!(code.toolbar_state().can_outdent);
    let code = EditorSession::open("```\nplain\n```");
    assert!(code.toolbar_state().can_indent);
    assert!(!code.toolbar_state().can_outdent);
}

#[test]
fn toolbar_keeps_inline_commands_enabled_for_prose_in_a_mixed_code_selection() {
    let mut session = EditorSession::open("plain\n\n```\ncode\n```");
    session
        .select(session.revision(), range(0, session.display_text().len()))
        .unwrap();
    assert!(session.toolbar_state().inline_allowed);
    session.select(session.revision(), range(7, 11)).unwrap();
    assert!(!session.toolbar_state().inline_allowed);
}

#[test]
fn toolbar_caret_keeps_container_eligibility_across_cut_rows() {
    use futo_notes_editor::ToolbarList;
    let source = format!(
        "- root\n{}",
        (0..2_000)
            .map(|i| format!("  - nested {i}\n"))
            .collect::<String>()
    );
    let mut session = EditorSession::open(&source);
    let at = session.display_text().find("nested 1700").unwrap();
    session.select(session.revision(), range(at, at)).unwrap();
    let state = session.toolbar_state();
    assert_eq!(state.list, Some(ToolbarList::Bullet));
    assert!(state.can_indent);
    assert!(state.can_outdent);
    assert_eq!(session.source_text(), source);
    assert_eq!(session.revision(), Revision(0));

    let source = format!("```\n{}```", "  body\n".repeat(2_000));
    let mut session = EditorSession::open(&source);
    session
        .select(session.revision(), range(7_000, 7_000))
        .unwrap();
    let state = session.toolbar_state();
    assert!(state.code);
    assert!(state.can_indent);
    assert!(state.can_outdent);
}

#[test]
fn collapsed_italic_survives_a_keyboards_double_space_period() {
    use futo_notes_editor::InlineFormat;
    // UIKit turns the trailing space into a period with one replace of that space (the caret
    // stays put, a typed space follows), or into ". " with one replace.
    for (replaced, then_typed, caret) in [(".", " ", 12), (". ", "", 13)] {
        let mut s = EditorSession::open("");
        s.toggle_format(s.revision(), InlineFormat::Italic, &mut |_| Ok(()))
            .unwrap();
        for (at, typed) in "hello world ".chars().enumerate() {
            s.replace(s.revision(), range(at, at), &typed.to_string(), &mut |_| {
                Ok(())
            })
            .unwrap();
        }
        s.replace_os(s.revision(), range(11, 12), replaced, &[], &mut |_| Ok(()))
            .unwrap();
        if !then_typed.is_empty() {
            s.replace(s.revision(), range(caret, caret), then_typed, &mut |_| {
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(s.toolbar_state().formats, vec![InlineFormat::Italic]);
        s.replace(s.revision(), range(13, 13), "n", &mut |_| Ok(()))
            .unwrap();
        assert_eq!(s.source_text(), "*hello world. n*", "{replaced:?}");
    }
}

#[test]
fn a_replaced_word_keeps_its_own_formats_whatever_the_caret_has_toggled() {
    use futo_notes_editor::InlineFormat::{Bold, Italic};
    // The carried formats are for the caret after a replace, not for the word it corrects: the
    // new text takes the formats of the first character it replaces.
    // (source, caret, toggled, replaced display range, text, expected source)
    let cases: [(&str, usize, _, _, &str, &str); 5] = [
        ("**abc**", 3, Bold, (0, 3), "xyz", "**xyz**"),
        ("abc", 3, Bold, (0, 3), "xyz", "xyz"),
        ("say abc", 7, Italic, (4, 7), "xyz", "say xyz"),
        ("x `abc`", 5, Bold, (2, 5), "xyz", "x `xyz`"),
        ("**abc** z", 3, Bold, (0, 5), "xyz z", "**xyz** z"),
    ];
    for (source, caret, format, (start, end), text, expected) in cases {
        let mut s = EditorSession::open(source);
        s.select(s.revision(), range(caret, caret)).unwrap();
        s.toggle_format(s.revision(), format, &mut |_| Ok(()))
            .unwrap();
        s.replace_os(s.revision(), range(start, end), text, &[], &mut |_| Ok(()))
            .unwrap();
        assert_eq!(s.source_text(), expected, "{source:?} {format:?}");
    }
}

#[test]
fn a_recomposed_word_takes_the_formats_of_its_first_character_after_a_toggle_off() {
    use futo_notes_editor::InlineFormat::Bold;
    let mut s = EditorSession::open("");
    s.toggle_format(s.revision(), Bold, &mut |_| Ok(()))
        .unwrap();
    for (at, typed) in "abc".chars().enumerate() {
        s.replace(s.revision(), range(at, at), &typed.to_string(), &mut |_| {
            Ok(())
        })
        .unwrap();
    }
    s.toggle_format(s.revision(), Bold, &mut |_| Ok(()))
        .unwrap();
    s.compose(s.revision(), range(0, 3), "abc").unwrap();
    s.commit_composition(s.revision(), Some("xyz"), &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "**xyz**");
}
