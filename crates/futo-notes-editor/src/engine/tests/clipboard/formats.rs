//! Formats a cut carries, and pastes at a caret carrying formats.
use super::super::super::Engine;
use super::super::{ok, range};
use crate::{Affinity, InlineFormat};

#[test]
fn cut_carries_the_cut_formats_to_the_next_typed_character() {
    let mut engine = Engine::open("a **bold** c");
    super::super::select(&mut engine, 2, 6, Affinity::Forward);
    let (copied, change) = engine
        .cut_markdown(engine.revision(), engine.selection(), &mut ok)
        .unwrap();
    assert_eq!(copied, "**bold**");
    assert!(change.is_some());
    assert_eq!(engine.source_text(), "a  c");
    assert_eq!(engine.active_formats(), vec![InlineFormat::Bold]);
    // Undo takes the cut back; Redo carries the formats again.
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "a **bold** c");
    assert_eq!(engine.selection(), range(2, 6));
    engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.active_formats(), vec![InlineFormat::Bold]);
    super::super::typed(&mut engine, "x");
    assert_eq!(engine.source_text(), "a **x** c");
    // Cut and typing are two Undo steps.
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "a  c");
}

#[test]
fn a_one_line_paste_takes_the_formats_the_caret_carries() {
    for (format, want) in [
        (InlineFormat::Bold, "a **x y** b"),
        (InlineFormat::Code, "a `x y` b"),
    ] {
        let mut engine = Engine::open("a  b");
        super::super::select(&mut engine, 2, 2, Affinity::Forward);
        engine
            .toggle_format_view(engine.revision(), format, &mut ok)
            .unwrap();
        engine
            .paste_markdown(engine.revision(), range(2, 2), "x y", &mut ok)
            .unwrap()
            .unwrap();
        assert_eq!(engine.source_text(), want);
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), "a  b");
    }
}

#[test]
fn a_one_line_paste_that_does_not_show_as_typed_takes_carried_formats() {
    // A link, an image and a wikilink do not show as typed, so typing
    // cannot shape them; the paste writes the carried formats' house marks
    // around them, and in code they show literally.
    for (format, text, want, shown) in [
        (InlineFormat::Bold, "[x](u)", "a **[x](u)** b", "a x b"),
        (InlineFormat::Italic, "[x](u)", "a *[x](u)* b", "a x b"),
        (
            InlineFormat::Bold,
            "![i](p.png)",
            "a **![i](p.png)** b",
            "a ![i](p.png) b",
        ),
        (
            InlineFormat::Bold,
            "[[note]]",
            "a **[[note]]** b",
            "a [[note]] b",
        ),
        (InlineFormat::Code, "[x](u)", "a `[x](u)` b", "a [x](u) b"),
        (
            InlineFormat::Code,
            "![i](p.png)",
            "a `![i](p.png)` b",
            "a ![i](p.png) b",
        ),
        (
            InlineFormat::Code,
            "[[note]]",
            "a `[[note]]` b",
            "a [[note]] b",
        ),
    ] {
        let mut engine = Engine::open("a  b");
        super::super::select(&mut engine, 2, 2, Affinity::Forward);
        engine
            .toggle_format_view(engine.revision(), format, &mut ok)
            .unwrap();
        let mut view = engine.display_text();
        let change = engine
            .paste_markdown(engine.revision(), range(2, 2), text, &mut ok)
            .unwrap()
            .unwrap();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(engine.source_text(), want, "{format:?} {text:?}");
        assert_eq!(engine.display_text(), shown, "{format:?} {text:?}");
        assert_eq!(view, shown, "{format:?} {text:?}: view change");
        let caret = shown.len() - 2;
        assert_eq!(
            engine.selection(),
            range(caret, caret),
            "{format:?} {text:?}"
        );
        let fresh = Engine::open(want);
        assert_eq!(fresh.display_text(), shown);
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), "a  b");
    }
}

#[test]
fn a_carried_paste_on_an_empty_line_takes_the_formats() {
    let mut engine = Engine::open("");
    engine
        .toggle_format_view(engine.revision(), InlineFormat::Bold, &mut ok)
        .unwrap();
    engine
        .paste_markdown(
            engine.revision(),
            range(0, 0),
            "[x](<https://x.test>)",
            &mut ok,
        )
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "**[x](<https://x.test>)**");
    assert_eq!(engine.display_text(), "x");
}

#[test]
fn a_carried_paste_that_would_read_otherwise_lands_plain() {
    // Inside a link's text, a bold link would be a link in a link: the
    // carried format is dropped and the link splits as any pasted link does.
    let mut engine = Engine::open("[ab](u)");
    super::super::select(&mut engine, 1, 1, Affinity::Forward);
    engine
        .toggle_format_view(engine.revision(), InlineFormat::Bold, &mut ok)
        .unwrap();
    engine
        .paste_markdown(engine.revision(), range(1, 1), "[x](v)", &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "[a](u)[x](v)[b](u)");
}
