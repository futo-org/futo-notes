use futo_notes_editor::EditorSession;

/// Strike carried over an empty caret, then bold and italic added after some
/// text was typed, must keep taking typed text (it was dropped).
#[test]
fn typing_continues_after_stacking_formats_onto_strike() {
    use futo_notes_editor::{InlineFormat, InputAction};
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
