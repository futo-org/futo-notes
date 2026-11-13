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
