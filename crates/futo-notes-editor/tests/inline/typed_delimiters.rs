use super::{assert_fresh, range, EditorSession, ReferenceView};

/// A delimiter typed where CommonMark flanking cannot keep it (or the row's
/// existing formatting) is written as escaped literal text: every keystroke
/// lands, the visible text gains only the typed character, and Undo restores
/// the exact source.
#[test]
fn typed_delimiters_that_cannot_format_land_as_escaped_literals() {
    for (original, at, typed, source) in [
        // A space after `_]_` would turn it into italics.
        ("text _]_word\n", 8, " ", "text \\_\\]\\_ word\n"),
        // `.*x` at the start of a two-line bold's second line.
        (
            "**two line\nbold** after\n",
            9,
            ".*x",
            "**two line\n.\\*xbold** after\n",
        ),
        // A star inside bold would pair with the bold's own markers.
        (
            "**two line\nbold** after\n",
            11,
            ">*b",
            "**two line\nbo>\\*bld** after\n",
        ),
        // A backtick inside bold would open code over its closing marker.
        (
            "- **item bold** and `code`\n",
            6,
            "`#",
            "- **item b\\`#old** and `code`\n",
        ),
    ] {
        let mut session = EditorSession::open(original);
        let mut view = ReferenceView::new(&session.display_text());
        let opened = view.text.clone();
        let mut caret = at;
        for ch in typed.chars() {
            let mut expected = view.text.clone();
            expected.insert(caret, ch);
            let change = session
                .replace_action(
                    session.revision(),
                    range(caret, caret),
                    &ch.to_string(),
                    futo_notes_editor::InputAction::Typing,
                    &mut |_| Ok(()),
                )
                .unwrap_or_else(|error| panic!("{error:?} typing {ch:?} into {original:?}"));
            view.apply(change);
            assert_fresh(&session, &view);
            assert_eq!(view.text, expected, "{original:?}");
            caret += ch.len_utf8();
        }
        assert_eq!(session.source_text(), source, "{original:?}");
        while let Some(change) = session.undo(session.revision(), &mut |_| Ok(())).unwrap() {
            view.apply(change);
        }
        assert_eq!(session.source_text(), original);
        assert_eq!(view.text, opened);
    }
}
