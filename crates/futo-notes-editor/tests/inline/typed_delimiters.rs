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

/// Text typed after a format span that directly follows inline code, outside
/// that span: the flanking repair encodes the typed scalar, never a code
/// character (code shows an entity verbatim).
#[test]
fn typing_after_a_span_that_follows_inline_code_lands() {
    use futo_notes_editor::Affinity;
    for original in ["`x`~-~", "`x`*-*", "`x`~~-~~", "`x`~y~", "`_`~-~"] {
        let mut session = EditorSession::open(original);
        let opened = session.display_text();
        let mut view = ReferenceView::new(&opened);
        let at = opened.len();
        session
            .select_with_affinity(session.revision(), range(at, at), Affinity::Forward)
            .unwrap();
        view.apply(
            session
                .replace(session.revision(), range(at, at), "a", &mut |_| Ok(()))
                .unwrap_or_else(|e| panic!("{original:?}: {e:?}")),
        );
        assert_fresh(&session, &view);
        assert_eq!(view.text, format!("{opened}a"), "{original:?}");
        assert!(
            EditorSession::open(&session.source_text())
                .display_text()
                .ends_with('a'),
            "{original:?}"
        );
    }
}

/// A delimiter typed on a blank line directly above a paragraph joins that
/// paragraph; it stays raw only while the joined paragraph reads as typed,
/// else it lands escaped, so it never pairs with that paragraph's syntax.
#[test]
fn a_delimiter_typed_above_a_paragraph_never_pairs_with_it() {
    for (original, at, typed, source) in [
        ("x\n\n`b` and `c\n", 2, "`", "x\n\\`\n`b` and `c\n"),
        ("x\n\n**b** `c\n", 2, "`", "x\n\\`\n**b** `c\n"),
        (
            "five\n\n7. seven `code` [link](https://x.y)\n",
            5,
            "`",
            "five\n\\`\n7. seven `code` [link](https://x.y)\n",
        ),
        // A star that cannot pair below stays raw.
        ("x\n\n*b c\n", 2, "*", "x\n*\n*b c\n"),
    ] {
        let mut session = EditorSession::open(original);
        let opened = session.display_text();
        let mut view = ReferenceView::new(&opened);
        session.select(session.revision(), range(at, at)).unwrap();
        view.apply(
            session
                .replace(session.revision(), range(at, at), typed, &mut |_| Ok(()))
                .unwrap(),
        );
        assert_fresh(&session, &view);
        assert_eq!(session.source_text(), source, "{original:?}");
    }
}

/// Typing that no inline spelling could verify used to refuse; it now lands,
/// escaped where needed, and the row reads as written.
#[test]
fn typing_no_inline_spelling_can_verify_still_lands() {
    use futo_notes_editor::Affinity;
    for (original, at, affinity, typed, source) in [
        // A quoted blank line above a list item that cannot interrupt the
        // paragraph the typed text starts: it joins, as at top level.
        (
            "> x\n> \n> 2. ordered\n",
            2,
            Affinity::Backward,
            "a",
            Some("> x\n> a\n> 2. ordered\n"),
        ),
        ("~~_*x*~_", 4, Affinity::Forward, "q", None),
        ("_*#*~b_under_ x", 4, Affinity::Forward, "~", None),
    ] {
        let mut session = EditorSession::open(original);
        let opened = session.display_text();
        let mut view = ReferenceView::new(&opened);
        session
            .select_with_affinity(session.revision(), range(at, at), affinity)
            .unwrap();
        view.apply(
            session
                .replace(session.revision(), range(at, at), typed, &mut |_| Ok(()))
                .unwrap_or_else(|e| panic!("{original:?}: {e:?}")),
        );
        assert_fresh(&session, &view);
        let letters = |text: &str| {
            text.chars()
                .filter(|c| c.is_alphabetic())
                .collect::<String>()
        };
        let mut expected = opened.clone();
        expected.insert_str(at, typed);
        assert_eq!(letters(&view.text), letters(&expected), "{original:?}");
        if let Some(source) = source {
            assert_eq!(session.source_text(), source);
        }
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), original);
    }
}
