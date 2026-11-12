//! Literal cases for the core. The five properties are in `properties.rs`.
mod commands;
mod fences;
mod projection;
mod properties;

use super::Engine;
use crate::{
    Affinity, CaretDirection, DisplayOffset, DisplayRange, EditorError, InputAction, Revision,
    SourceEdit,
};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

fn ok(_: &SourceEdit) -> Result<(), String> {
    Ok(())
}

fn typed(engine: &mut Engine, text: &str) {
    let at = engine.selection();
    engine
        .replace(engine.revision(), at, text, InputAction::Typing, &mut ok)
        .unwrap();
}

fn select(engine: &mut Engine, start: usize, end: usize, affinity: Affinity) {
    engine
        .select_with_affinity(engine.revision(), range(start, end), affinity)
        .unwrap();
}

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
fn typing_in_an_empty_code_block_writes_a_line_for_it() {
    for (source, caret, written) in [
        ("```\n```\nb", 0, "```\nx\n```\nb"),
        ("```\r\n```", 0, "```\r\nx\r\n```"),
        ("a\n```", 2, "a\n```\nx"),
        ("a\r\n```", 3, "a\r\n```\r\nx"),
    ] {
        let mut engine = Engine::open(source);
        select(&mut engine, caret, caret, Affinity::Backward);
        typed(&mut engine, "x");
        assert_eq!(engine.source_text(), written, "{source:?}");
        assert_eq!(engine.display_text(), Engine::open(written).display_text());
        typed(&mut engine, "y");
        assert_eq!(
            engine.source_text(),
            written.replace('x', "xy"),
            "{source:?}"
        );
    }
}

#[test]
fn front_matter_is_metadata_and_the_caret_starts_in_the_body() {
    let source = "---\ntitle: x\ntags: [a, b]\n---\n# Body\n";
    let mut engine = Engine::open(source);
    assert_eq!(engine.display_text(), "title: x\ntags: [a, b]\nBody\n");
    assert_eq!(engine.selection(), range(22, 22));
    let snapped = |engine: &mut Engine, wanted: DisplayRange| {
        engine.select(Revision(0), wanted).unwrap().selection
    };
    assert_eq!(snapped(&mut engine, range(0, 3)), range(22, 22));
    assert_eq!(snapped(&mut engine, range(5, 24)), range(22, 24));
    assert_eq!(snapped(&mut engine, range(0, 27)), range(0, 27));
    assert_eq!(
        engine.replace(Revision(0), range(2, 3), "y", InputAction::Typing, &mut ok),
        Err(EditorError::InvalidRange)
    );
    select(&mut engine, 22, 22, Affinity::Backward);
    typed(&mut engine, "z");
    assert_eq!(
        engine.source_text(),
        "---\ntitle: x\ntags: [a, b]\n---\n# zBody\n"
    );
    // Deleting everything takes the front matter too.
    let all = engine.display_len();
    engine
        .replace(
            engine.revision(),
            range(0, all),
            "",
            InputAction::Typing,
            &mut ok,
        )
        .unwrap();
    assert_eq!(engine.source_text(), "");

    for (source, display, written) in [
        ("---\na: 1\n---\n", "a: 1\n", "---\na: 1\n---\nX"),
        ("---\r\na: 1\r\n---", "a: 1\r\n", "---\r\na: 1\r\n---\r\nX"),
        ("---\n---\nbody", "body", "---\n---\nXbody"),
        ("---\na\n", "\u{fffc}\na\n", "---\na\nX"),
    ] {
        let mut engine = Engine::open(source);
        assert_eq!(engine.display_text(), display, "{source:?}");
        let body = engine.selection();
        if source.starts_with("---\na\n") {
            select(
                &mut engine,
                display.len(),
                display.len(),
                Affinity::Backward,
            );
        } else {
            assert_eq!(engine.selection(), body);
        }
        typed(&mut engine, "X");
        assert_eq!(engine.source_text(), written, "{source:?}");
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
fn typing_markdown_one_character_at_a_time_writes_exactly_what_was_typed() {
    for typed_text in ["**a**b", "*a*_b_", "[a](u)x", "`c`d", "- # x", "\\*a"] {
        let mut engine = Engine::open("");
        for ch in typed_text.chars() {
            typed(&mut engine, &ch.to_string());
        }
        assert_eq!(engine.source_text(), typed_text);
    }
}

#[test]
fn deleting_text_keeps_the_formats_around_it_and_drops_emptied_spans() {
    for (source, start, end, text, written) in [
        ("a**b**c", 1, 2, "", "ac"),
        ("a**bc**d", 1, 2, "", "a**c**d"),
        ("a**bc**d", 0, 2, "x", "x**c**d"),
        ("a**bc**d", 2, 4, "x", "a**bx**"),
        ("a**b**c", 1, 2, "x", "a**x**c"),
        ("**_b_**", 0, 1, "", ""),
        ("a\n- b", 1, 2, "", "ab"),
        ("- a\n- b", 0, 2, "", "- b"),
        ("x\\*y", 1, 2, "", "xy"),
        ("[ab](u)", 0, 2, "", ""),
    ] {
        let mut engine = Engine::open(source);
        select(&mut engine, start, end, Affinity::Backward);
        typed(&mut engine, text);
        assert_eq!(
            engine.source_text(),
            written,
            "{source:?} {start}..{end} {text:?}"
        );
    }
}

/// Replacing a selection: the visible text in it goes, with the markers of
/// lines it joins and the hidden lines inside it; spans reaching out of it
/// keep their marks; spans it empties lose theirs unless the text lands in
/// them; the text lands at the selection's start, inside spans starting there.
/// Each case: source, the selected display text (its first occurrence), the
/// text typed over it, and the source written.
#[test]
fn replacing_a_selection_writes_these_bytes() {
    for (source, selected, text, written) in [
        // Plain text.
        ("hello world", "lo wo", "", "helrld"),
        ("hello world", "lo wo", "X", "helXrld"),
        ("a\r\nb", "\r\n", "", "ab"),
        // A span the selection covers exactly: kept when text lands in it.
        ("a **bold** c", "bold", "X", "a **X** c"),
        ("a **bold** c", "bold", "", "a  c"),
        ("x **a** y", "x a y", "", ""),
        ("**a _b_ c**", "b", "X", "**a _X_ c**"),
        ("**_b_**", "b", "", ""),
        ("*a* b *c*", "a b c", "", ""),
        // Spans reaching out of the selection keep their marks after the text.
        ("a **bold** c", "a b", "X", "X**old** c"),
        ("a **bold** c", "ld c", "X", "a **boX**"),
        ("a **bold** c", "old", "", "a **b** c"),
        ("a **bo** _it_ c", "o i", "", "a **b**_t_ c"),
        ("`abc`", "b", "", "`ac`"),
        ("`abc` d", "c d", "", "`ab`"),
        // A span ending where one of its kind starts joins it.
        ("**ab** **cd**", "b c", "", "**ad**"),
        ("**ab** **cd**", "b c", "X", "**aXd**"),
        ("_a_ _b_", "a b", "X", "_X_"),
        ("`a` `b`", "a b", "", ""),
        // Links: the text is a span; the destination stays with the close.
        ("x [link](u) z", "link", "Y", "x [Y](u) z"),
        ("x [link](u) z", "nk z", "", "x [li](u)"),
        ("x [link](u) z", "x li", "", "[nk](u) z"),
        ("[a](u) [b](v)", "a b", "", ""),
        ("<https://x.y> z", "https://x.y", "", " z"),
        // Marks with no hidden syntax are plain text to a selection.
        ("see https://x.y", "x.y", "", "see https://"),
        ("[[note]] x", "note]", "", "[[] x"),
        ("![alt](p.png) x", "p.png", "", "![alt]() x"),
        // An escape goes with its character.
        ("x \\*y\\* z", "*y*", "", "x  z"),
        ("x\\*y", "x*", "", "y"),
        // Lines: joining takes the later line's marker.
        ("# Title\nbody", "le\nbo", "", "# Titdy"),
        ("- one\n- two", "ne\ntw", "", "- oo"),
        ("- one\n- two", "one\n", "", "- two"),
        ("> a\n> b", "a\nb", "X", "> X"),
        ("# Title", "Title", "X", "# X"),
        ("1. a\n2. b\n3. c", "a\nb\nc", "", "1. "),
        // Hidden lines inside the selection go with it, except a fence
        // frame line whose block goes on outside it: that stays, after the
        // joined line, and goes when no code line is left (fences/cut.rs).
        ("a\n```\ncode\n```\nb", "a\nco", "", "de\nb"),
        ("a\n```\ncode\n```\nb", "de\nb", "", "a\n```\nco\n```"),
        ("a\n---\nb", "\u{fffc}", "", "a\n\nb"),
        ("a\n---\nb", "a\n\u{fffc}", "X", "X\nb"),
        // A selection starting on an empty code block's line keeps the block.
        ("```\n```\nb", "\nb", "X", "```\nX\n```"),
        // Tables: cells are text; pipes show and are selected like text.
        (
            "| a | b |\n|---|---|\n| c | d |",
            "a | b",
            "X",
            "| X |\n|---|---|\n| c | d |",
        ),
        // All of the front matter goes with a selection covering it.
        ("---\nk: v\n---\nbody", "k: v\nbody", "X", "X"),
    ] {
        let mut engine = Engine::open(source);
        let display = engine.display_text();
        let start = display
            .find(selected)
            .unwrap_or_else(|| panic!("{selected:?} not shown in {display:?}"));
        let selection = range(start, start + selected.len());
        let before = engine.select(Revision(0), selection).unwrap();
        let change = engine
            .replace(Revision(0), selection, text, InputAction::Typing, &mut ok)
            .unwrap()
            .expect("a change");
        assert_eq!(
            engine.source_text(),
            written,
            "{source:?}: {selected:?} -> {text:?}"
        );
        let mut view = display.clone();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, engine.display_text(), "{source:?}: view change");
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), source, "{source:?}: undo");
        assert_eq!(engine.selection(), before.selection, "{source:?}: undo");
    }
}

#[test]
fn backspace_and_delete_take_one_grapheme() {
    let mut engine = Engine::open("e\u{301}x\r\ny");
    select(&mut engine, 3, 3, Affinity::Backward);
    engine
        .delete(Revision(0), CaretDirection::Backward, &mut ok)
        .unwrap();
    assert_eq!(engine.source_text(), "x\r\ny");
    select(&mut engine, 1, 1, Affinity::Backward);
    engine
        .delete(engine.revision(), CaretDirection::Forward, &mut ok)
        .unwrap();
    assert_eq!(engine.source_text(), "xy");
    select(&mut engine, 0, 0, Affinity::Forward);
    assert_eq!(
        engine.delete(engine.revision(), CaretDirection::Backward, &mut ok),
        Ok(None)
    );
}

#[test]
fn a_refused_acceptance_changes_nothing() {
    let mut engine = Engine::open("a\nb");
    select(&mut engine, 1, 1, Affinity::Backward);
    let error = engine.replace(
        Revision(0),
        range(1, 1),
        "x",
        InputAction::Typing,
        &mut |_| Err("disk full".into()),
    );
    assert_eq!(error, Err(EditorError::Persistence("disk full".into())));
    assert_eq!(engine.source_text(), "a\nb");
    assert_eq!(engine.revision(), Revision(0));
    assert_eq!(
        engine.undo(Revision(0), &mut ok),
        Ok(None),
        "a refused edit leaves no history"
    );
}

#[test]
fn typing_joins_one_undo_step_and_undo_restores_the_selection() {
    let mut engine = Engine::open("ab");
    select(&mut engine, 1, 1, Affinity::Backward);
    for ch in ["x", "y", "z"] {
        typed(&mut engine, ch);
    }
    assert_eq!(engine.source_text(), "axyzb");
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "ab");
    assert_eq!(engine.selection(), range(1, 1));
    engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "axyzb");
    assert_eq!(engine.selection(), range(4, 4));
}

#[test]
fn composition_commits_once_and_input_during_it_commits_it_first() {
    let mut engine = Engine::open("ab");
    select(&mut engine, 1, 1, Affinity::Backward);
    engine.compose(Revision(0), range(1, 1), "k").unwrap();
    engine.compose(Revision(0), range(1, 1), "か").unwrap();
    assert_eq!(engine.source_text(), "ab");
    assert_eq!(engine.undo(Revision(0), &mut ok), Ok(None));
    let change = engine
        .commit_composition(Revision(0), None, &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(change.edit.inserted, "か");
    assert_eq!(engine.source_text(), "aかb");

    let mut engine = Engine::open("ab");
    select(&mut engine, 1, 1, Affinity::Backward);
    engine.compose(Revision(0), range(1, 1), "か").unwrap();
    let mut accepted = 0;
    engine
        .replace(
            Revision(0),
            range(4, 4),
            "!",
            InputAction::Typing,
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(engine.source_text(), "aか!b");
    engine.undo(engine.revision(), &mut ok).unwrap();
    assert_eq!(engine.source_text(), "aかb");
    engine.undo(engine.revision(), &mut ok).unwrap();
    assert_eq!(engine.source_text(), "ab");
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
