//! Committing marked text and text-service replacements: only what differs
//! from the display is replaced, so characters kept keep their spelling.
use super::super::Engine;
use super::{ok, range};
use crate::{DisplayReplacement, InputAction};

#[test]
fn a_commit_replaces_only_the_stretch_that_differs() {
    // (source, marked range, marked text, source after the commit)
    for (source, (start, end), text, written) in [
        ("half**way** there", (0, 7), "hallway", "hall**way** there"),
        ("a **bc**", (0, 4), "a xc", "a **xc**"),
        ("**ab**cd", (1, 3), "日本", "**a日本**d"),
        ("**😀** x", (4, 4), "か", "**😀か** x"),
        ("__word__", (0, 4), "word", "__word__"),
    ] {
        let mut engine = Engine::open(source);
        engine
            .compose(engine.revision(), range(start, end), text)
            .unwrap();
        engine
            .commit_composition(engine.revision(), None, &mut ok)
            .unwrap();
        assert_eq!(engine.source_text(), written, "{source:?}");
        let caret = start + text.len();
        assert_eq!(engine.selection(), range(caret, caret), "{source:?}");
        while engine.undo(engine.revision(), &mut ok).unwrap().is_some() {}
        assert_eq!(engine.source_text(), source, "{source:?}");
    }
}

#[test]
fn a_text_service_correction_keeps_the_marks_between_its_words() {
    let mut engine = Engine::open("teh __middle__ wrng\r\n");
    let all = range(0, engine.display_len());
    engine
        .replace(
            engine.revision(),
            all,
            "the middle wrong\r\n",
            InputAction::Isolated,
            &mut ok,
        )
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "the __middle__ wrong\r\n");
    assert_eq!(engine.selection(), range(18, 18));
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "teh __middle__ wrng\r\n");
}

#[test]
fn several_replacements_are_one_action_after_the_marked_text_commits() {
    let mut engine = Engine::open("__a__ tail");
    engine
        .compose(engine.revision(), range(1, 1), "日")
        .unwrap();
    let runs = [
        DisplayReplacement {
            range: range(0, 1),
            inserted: "A".into(),
        },
        DisplayReplacement {
            range: range(5, 9),
            inserted: "end".into(),
        },
    ];
    let mut accepted = 0;
    engine
        .replace_runs(engine.revision(), &runs, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(engine.source_text(), "__A日__ end");
    assert_eq!(engine.selection(), range(8, 8));
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "__a日__ tail");
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "__a__ tail");
}

#[test]
fn typing_at_a_dividers_edge_writes_a_line_beside_the_rule() {
    // (source, caret, typed, source after, display after, caret after)
    for (source, caret, typed, written, shown, after) in [
        ("---", 0, "é", "é\n---", "é\n\u{fffc}", 2),
        ("***", 0, "é", "é\n***", "é\n\u{fffc}", 2),
        ("---", 3, "Hello", "---\nHello", "\u{fffc}\nHello", 9),
        (
            "a\n\n***",
            6,
            "Hello",
            "a\n\n***\nHello",
            "a\n\n\u{fffc}\nHello",
            12,
        ),
        (
            "# H\r\n***",
            6,
            "x",
            "# H\r\n***\r\nx",
            "H\r\n\u{fffc}\r\nx",
            9,
        ),
        ("x\n---\ny", 2, "\n", "x\n\n---\ny", "x\n\n\u{fffc}\ny", 3),
    ] {
        let mut engine = Engine::open(source);
        engine
            .select_with_affinity(
                engine.revision(),
                range(caret, caret),
                crate::Affinity::Backward,
            )
            .unwrap();
        let at = engine.selection();
        engine
            .replace(engine.revision(), at, typed, InputAction::Typing, &mut ok)
            .unwrap()
            .unwrap();
        assert_eq!(engine.source_text(), written, "{source:?}");
        assert_eq!(engine.display_text(), shown, "{source:?}");
        assert_eq!(engine.selection(), range(after, after), "{source:?}");
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), source, "{source:?}");
    }
}

#[test]
fn marked_text_after_a_divider_commits_on_its_own_line() {
    // A key while text is marked lands after it.
    let mut engine = Engine::open("a\n\n---");
    engine.select(engine.revision(), range(6, 6)).unwrap();
    engine.compose(engine.revision(), range(6, 6), "e").unwrap();
    engine
        .replace(
            engine.revision(),
            range(7, 7),
            " ",
            InputAction::Typing,
            &mut ok,
        )
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "a\n\n---\ne ");
    assert_eq!(engine.selection(), range(9, 9));
    // A text service replacing the marked text.
    let mut engine = Engine::open("# H\n***");
    engine.select(engine.revision(), range(5, 5)).unwrap();
    engine.compose(engine.revision(), range(5, 5), "e").unwrap();
    engine
        .replace(
            engine.revision(),
            range(5, 6),
            "é",
            InputAction::Isolated,
            &mut ok,
        )
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "# H\n***\né");
    assert_eq!(engine.selection(), range(8, 8));
}

#[test]
fn input_while_marked_addresses_the_provisional_display_when_the_commit_hides_marks() {
    // Committing the marked text closes a span, so marks before it and inside
    // it hide; the input still lands on the character it addressed.
    // (source, marked range, marked text, input range, source after, caret)
    for (source, at, text, (start, end), written, caret) in [
        (
            "",
            0,
            "x *b https://x.test/a* ",
            (3, 4),
            "x *B https://x.test/a* ",
            3,
        ),
        (
            "x *b ",
            5,
            "b https://x.test/a* ",
            (3, 4),
            "x *B b https://x.test/a* ",
            3,
        ),
        (
            "x *b ",
            5,
            "b https://x.test/a* ",
            (5, 6),
            "x *b B https://x.test/a* ",
            5,
        ),
        ("x *b ", 5, "b* tail", (12, 12), "x *b b* tailX", 11),
        ("x b* tail", 2, "*", (6, 6), "x *b* Xtail", 5),
    ] {
        let mut engine = Engine::open(source);
        engine
            .compose(engine.revision(), range(at, at), text)
            .unwrap();
        let mut accepted = 0;
        let input = if start == end { "X" } else { "B" };
        engine
            .replace(
                engine.revision(),
                range(start, end),
                input,
                InputAction::Typing,
                &mut |_| {
                    accepted += 1;
                    Ok(())
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(accepted, 1, "{source:?} {text:?}");
        assert_eq!(engine.source_text(), written, "{source:?} {text:?}");
        assert_eq!(
            engine.selection(),
            range(caret, caret),
            "{source:?} {text:?}"
        );
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), source, "{source:?} {text:?}");
    }
}
