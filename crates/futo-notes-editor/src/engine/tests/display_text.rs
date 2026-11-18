//! The display text: what it hides, what shows as one object character, and
//! the offsets a caret may take in it.
use super::super::Engine;
use super::{range, select};
use crate::{Affinity, EditorError, Revision};

#[test]
fn markers_and_inline_syntax_are_hidden() {
    for (source, display) in [
        ("# Title", "Title"),
        ("- milk\n  the oat kind", "milk\nthe oat kind"),
        ("3) third\n- [x] done", "third\ndone"),
        ("> quoted\n>\n> > deep", "quoted\n\ndeep"),
        ("a **b** _c_ ~~d~~ `e`", "a b c d e"),
        (
            "[text](https://x.y) <https://x.y> https://x.y",
            "text https://x.y https://x.y",
        ),
        ("![alt](p.png) [[note]] #tag", "![alt](p.png) [[note]] #tag"),
        ("\\*not italic\\*", "*not italic*"),
        ("-\n#\n>text\n- - -", "-\n#\n>text\n- -"),
        ("**not\nbold**", "**not\nbold**"),
        ("a\r\nb\rc\n", "a\r\nb\rc\n"),
        (
            "| **a** | b\\|c |\n|:--|--:|\n| x |",
            "| a | b|c |\n|:--|--:|\n| x |",
        ),
    ] {
        assert_eq!(Engine::open(source).display_text(), display, "{source:?}");
    }
}

#[test]
fn fence_lines_are_hidden_and_an_empty_block_shows_one_empty_line() {
    for (source, display) in [
        ("a\n```js\ncode\n```\nb", "a\ncode\nb"),
        ("```\ncode\n```", "code"),
        ("```\ncode\n```\n", "code\n"),
        ("```\ncode", "code"),
        ("```\n\n```", ""),
        ("```\n```\nb", "\nb"),
        ("```\n```", ""),
        ("a\n```", "a\n"),
        ("a\n```\n", "a\n"),
        ("~~~~\n```\n~~~~", "```"),
    ] {
        assert_eq!(Engine::open(source).display_text(), display, "{source:?}");
    }
}

#[test]
fn a_divider_is_one_object_character() {
    let mut engine = Engine::open("a\n---\nb");
    assert_eq!(engine.display_text(), "a\n\u{fffc}\nb");
    assert!(engine.check_display(3).is_err());
    select(&mut engine, 2, 2, Affinity::Backward);
    assert_eq!(engine.caret_source(), 2);
    select(&mut engine, 5, 5, Affinity::Backward);
    assert_eq!(engine.caret_source(), 5);
}

#[test]
fn a_caret_never_stands_inside_a_marker_or_an_escape() {
    let engine = Engine::open("- **a** \\*b");
    // Display "a *b": at 0 the caret is after the bullet, before or after `**`.
    assert_eq!(engine.display_text(), "a *b");
    assert_eq!(engine.source_bounds(0), (2, 4));
    assert_eq!(engine.source_bounds(1), (5, 7));
    // Before `*`: only before the backslash.
    assert_eq!(engine.source_bounds(2), (8, 8));
}

#[test]
fn utf16_conversions_refuse_a_split_surrogate_pair() {
    // Emoji are punctuation to the delimiter rules, so the closing `**`
    // needs the space after it.
    let engine = Engine::open("**😀** x");
    assert_eq!(engine.display_text(), "😀 x");
    let display = |start, end| {
        engine.display_from_utf16(
            Revision(0),
            crate::DisplayUtf16Range {
                start: crate::DisplayUtf16Offset(start),
                end: crate::DisplayUtf16Offset(end),
            },
        )
    };
    assert_eq!(display(0, 2), Ok(range(0, 4)));
    assert_eq!(display(1, 2), Err(EditorError::InvalidRange));
    assert_eq!(display(4, 5), Err(EditorError::InvalidRange));
}
