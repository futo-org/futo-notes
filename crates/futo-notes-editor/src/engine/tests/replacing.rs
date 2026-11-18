//! Replacing and deleting text: the bytes written, the formats kept around
//! it, and undo back to the exact source.
use super::super::Engine;
use super::{ok, range, select, typed};
use crate::{Affinity, CaretDirection, InputAction, Revision};

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
        // Also when only what lies between them goes: they would touch.
        ("**ab** **cd**", " ", "", "**abcd**"),
        ("**ab**\n**cd**", "\n", "", "**abcd**"),
        ("__~~ab~~__\n__~~cd~~__", "\n", "", "__~~abcd~~__"),
        ("**ab**\n**cd**", "\n", "X", "**ab**X**cd**"),
        // Links: the text is a span; the destination stays with the close.
        ("x [link](u) z", "link", "Y", "x [Y](u) z"),
        ("x [link](u) z", "nk z", "", "x [li](u)"),
        ("x [link](u) z", "x li", "", "[nk](u) z"),
        ("[a](u) [b](v)", "a b", "", ""),
        ("<https://x.y> z", "https://x.y", "", " z"),
        // Marks with no hidden syntax are plain text to a selection.
        ("see https://x.y", "x.y", "", "see https://"),
        ("[[note]] x", "note]", "", "[[] x"),
        ("![alt](p.png) x", "p.png", "", " x"),
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
        // Hidden lines inside the selection go with it, and a code block it
        // reaches into or out of goes whole (fences/reach.rs).
        ("a\n```\ncode\n```\nb", "a\nco", "", "\nb"),
        ("a\n```\ncode\n```\nb", "de\nb", "", "a\n"),
        ("a\n---\nb", "\u{fffc}", "", "a\n\nb"),
        ("a\n---\nb", "a\n\u{fffc}", "X", "X\nb"),
        // An empty code block has no inside: a selection from its line
        // takes it whole.
        ("```\n```\nb", "\nb", "X", "X"),
        // Tables: cells are text; pipes show and are selected like text.
        (
            "| a | b |\n|---|---|\n| c | d |",
            "a | b",
            "X",
            "| X |\n|---|---|\n| c | d |",
        ),
        // A selection covering the front matter replaces the body only.
        (
            "---\nk: v\n---\nbody",
            "k: v\nbody",
            "X",
            "---\nk: v\n---\nX",
        ),
        ("---\n---\nbody", "body", "X", "---\n---\nX"),
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
