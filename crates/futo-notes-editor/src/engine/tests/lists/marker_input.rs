//! Input at an item's marker: with the caret just after the marker unit it
//! lands after the marker, and with the caret just before it, before the
//! marker; for typing, a text service's insertion, a composition and a paste,
//! with and without Bold carried.
use super::super::{ok, range};
use crate::engine::Engine;
use crate::{Affinity, InlineFormat, InputAction};

#[derive(Clone, Copy, Debug)]
enum Input {
    Typing,
    Service,
    Composition,
    Paste,
}

/// `source` after `x` goes in at display offset `at` by `input`.
fn landed(source: &str, at: usize, bold: bool, input: Input) -> String {
    let mut engine = Engine::open(source);
    let caret = range(at, at);
    let affinity = if at == 0 {
        Affinity::Forward
    } else {
        Affinity::Backward
    };
    engine
        .select_with_affinity(engine.revision(), caret, affinity)
        .unwrap();
    if bold {
        engine
            .toggle_format_view(engine.revision(), InlineFormat::Bold, &mut ok)
            .unwrap();
    }
    let revision = engine.revision();
    match input {
        Input::Typing => {
            engine
                .replace(revision, caret, "x", InputAction::Typing, &mut ok)
                .unwrap();
        }
        Input::Service => {
            engine
                .replace(revision, caret, "x", InputAction::Isolated, &mut ok)
                .unwrap();
        }
        Input::Composition => {
            engine.compose(revision, caret, "x").unwrap();
            engine
                .commit_composition(engine.revision(), None, &mut ok)
                .unwrap();
        }
        Input::Paste => {
            engine
                .paste_markdown(revision, caret, "x", &mut ok)
                .unwrap();
        }
    }
    engine.source_text()
}

#[test]
fn input_lands_on_the_side_of_the_marker_the_caret_is_on() {
    let mut wrong = Vec::new();
    // (source, the marker's source range)
    for (source, marker) in [
        ("- ", 0..2),
        ("10. ", 0..4),
        ("- [ ] ", 0..6),
        ("> - ", 2..4),
        ("  1) ", 2..5),
        ("- a", 0..2),
        ("> \t- [x] a", 3..9),
    ] {
        let (hidden, item) = (&source[..marker.start], &source[marker.clone()]);
        let text = &source[marker.end..];
        for input in [
            Input::Typing,
            Input::Service,
            Input::Composition,
            Input::Paste,
        ] {
            for bold in [false, true] {
                let x = if bold { "**x**" } else { "x" };
                for (at, want) in [
                    (3, format!("{hidden}{item}{x}{text}")),
                    (0, format!("{hidden}{x}{item}{text}")),
                ] {
                    let got = landed(source, at, bold, input);
                    if got != want {
                        wrong.push(format!(
                            "{input:?} bold {bold} at {at} in {source:?}: {got:?}, want {want:?}"
                        ));
                    }
                }
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "{} wrong:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}

/// A word typed in Bold, Bold turned off, then completed by a text service:
/// the completed word is plain, on the side of the marker it was typed on.
#[test]
fn a_completed_word_lands_on_the_side_of_the_marker_it_was_typed_on() {
    for (source, hidden, item, text) in [
        ("- ", "", "- ", ""),
        ("1. ", "", "1. ", ""),
        ("- [ ] ", "", "- [ ] ", ""),
        ("> - a", "> ", "- ", "a"),
        ("  * a", "  ", "* ", "a"),
    ] {
        for (at, want) in [
            (3, format!("{hidden}{item}hello{text}")),
            (0, format!("{hidden}hello{item}{text}")),
        ] {
            let mut engine = Engine::open(source);
            let affinity = if at == 0 {
                Affinity::Forward
            } else {
                Affinity::Backward
            };
            engine
                .select_with_affinity(engine.revision(), range(at, at), affinity)
                .unwrap();
            let bold = |engine: &mut Engine| {
                engine
                    .toggle_format_view(engine.revision(), InlineFormat::Bold, &mut ok)
                    .unwrap();
            };
            bold(&mut engine);
            engine
                .replace(
                    engine.revision(),
                    range(at, at),
                    "hel",
                    InputAction::Typing,
                    &mut ok,
                )
                .unwrap();
            bold(&mut engine);
            let end = engine.selection().end.0;
            engine
                .replace(
                    engine.revision(),
                    range(end - 3, end),
                    "hello",
                    InputAction::Isolated,
                    &mut ok,
                )
                .unwrap();
            assert_eq!(engine.source_text(), want, "{source:?} at {at}");
        }
    }
}
