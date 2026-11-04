use futo_notes_editor::{EditorSession, InlineFormat, InputAction};

fn type_text(s: &mut EditorSession, text: &str) {
    for ch in text.chars() {
        let at = s.selection();
        s.replace_action(
            s.revision(),
            at,
            &ch.to_string(),
            InputAction::Typing,
            &mut |_| Ok(()),
        )
        .unwrap();
    }
}

fn toggle(s: &mut EditorSession, f: InlineFormat) {
    s.toggle_format(s.revision(), f, &mut |_| Ok(())).unwrap();
}

/// Strike carried over an empty caret, then bold and italic added after some
/// text was typed, must keep taking typed text (it was dropped).
#[test]
fn typing_continues_after_stacking_formats_onto_strike() {
    // strike, type, then bold and italic on.
    let mut s = EditorSession::open("");
    toggle(&mut s, InlineFormat::Strike);
    type_text(&mut s, "ab");
    toggle(&mut s, InlineFormat::Bold);
    toggle(&mut s, InlineFormat::Italic);
    type_text(&mut s, "cd");
    assert_eq!(s.display_text(), "abcd");
    assert_eq!(s.source_text(), "~~ab***cd***~~");

    // strike, type, then italic alone: one strike span, not a reopened one.
    let mut s = EditorSession::open("");
    toggle(&mut s, InlineFormat::Strike);
    type_text(&mut s, "ab");
    toggle(&mut s, InlineFormat::Italic);
    type_text(&mut s, "cd");
    assert_eq!(s.display_text(), "abcd");
    assert_eq!(s.source_text(), "~~ab*cd*~~");

    // italic first, then bold on top: the pair shares one `***` run.
    let mut s = EditorSession::open("");
    toggle(&mut s, InlineFormat::Italic);
    type_text(&mut s, "ab");
    toggle(&mut s, InlineFormat::Bold);
    type_text(&mut s, "cd");
    assert_eq!(s.display_text(), "abcd");
    assert_eq!(s.source_text(), "*ab**cd***");
}

/// Dropping a format after a trailing space leaves the new text unable to join
/// the span beside it; it opens spans of its own instead of being refused.
#[test]
fn typing_continues_after_dropping_a_format_past_a_space() {
    use futo_notes_editor::InlineFormat::{Bold, Italic, Strike};
    let cases: [(&[futo_notes_editor::InlineFormat], &str, &str); 3] = [
        (&[Strike, Bold, Italic], "~~***abcd***~~ ~~**ef**~~", "I"),
        (&[Bold, Italic], "***abcd*** **ef**", "I"),
        (&[Strike, Italic], "~~*abcd*~~ *ef*", "S"),
    ];
    for (on, source, off) in cases {
        let mut s = EditorSession::open("");
        for format in on {
            toggle(&mut s, *format);
        }
        type_text(&mut s, "abcd ");
        toggle(
            &mut s,
            match off {
                "I" => Italic,
                _ => Strike,
            },
        );
        type_text(&mut s, "ef");
        assert_eq!(s.display_text(), "abcd ef", "{source}");
        assert_eq!(s.source_text(), source);
    }
}
