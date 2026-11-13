//! Input a native control sends: at a caret it placed itself, several runs
//! as one action, and caret moves that collapse a selection.
use super::super::Engine;
use super::{ok, range, select, typed};
use crate::{Affinity, CaretDirection, EditorError, InputAction};

fn undo(engine: &mut Engine) -> bool {
    engine.undo(engine.revision(), &mut ok).unwrap().is_some()
}

#[test]
fn input_at_a_caret_the_host_placed_lands_inside_the_span_it_ends() {
    // The core's own caret is at the note's start (affinity Forward); input
    // at the end of the bold stands where a fresh selection there would.
    let mut engine = Engine::open("__日__\r\n");
    assert_eq!(engine.selection(), range(0, 0));
    engine
        .replace(
            engine.revision(),
            range(3, 3),
            "a",
            InputAction::Typing,
            &mut ok,
        )
        .unwrap();
    assert_eq!(engine.source_text(), "__日a__\r\n");
    assert_eq!(engine.selection(), range(4, 4));
    // At the note's start it stands after the hidden marks.
    let mut engine = Engine::open("# Title\n\nbody");
    select(&mut engine, 6, 6, Affinity::Backward);
    engine
        .replace(
            engine.revision(),
            range(0, 0),
            "A ",
            InputAction::Typing,
            &mut ok,
        )
        .unwrap();
    assert_eq!(engine.source_text(), "# A Title\n\nbody");
}

#[test]
fn several_runs_are_one_action_with_one_acceptance_and_one_undo_step() {
    let opening = "__cat__ & _dog_  \r\n";
    let mut engine = Engine::open(opening);
    select(&mut engine, 0, 9, Affinity::Forward);
    let runs = [(range(0, 3), "kitten"), (range(6, 9), "ox")];
    let mut calls = 0;
    assert_eq!(
        engine
            .replace_many(engine.revision(), &runs, &mut |_| {
                calls += 1;
                Err("full".into())
            })
            .err(),
        Some(EditorError::Persistence("full".into()))
    );
    assert_eq!(calls, 1);
    assert_eq!(engine.source_text(), opening);
    assert_eq!(engine.selection(), range(0, 9));
    let mut calls = 0;
    let change = engine
        .replace_many(engine.revision(), &runs, &mut |_| {
            calls += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(calls, 1);
    // Unchanged text between the runs keeps its spelling.
    assert_eq!(engine.source_text(), "__kitten__ & _ox_  \r\n");
    assert_eq!(change.edit.removed, "cat__ & _dog");
    assert_eq!(engine.selection(), range(11, 11));
    assert!(undo(&mut engine));
    assert_eq!(engine.source_text(), opening);
    assert_eq!(engine.selection(), range(0, 9));
    assert_eq!(engine.affinity(), Affinity::Forward);
    assert!(!undo(&mut engine));
}

#[test]
fn runs_out_of_order_overlapping_or_missing_change_nothing() {
    let mut engine = Engine::open("one two three");
    for runs in [
        vec![],
        vec![(range(4, 7), "2"), (range(0, 3), "1")],
        vec![(range(0, 5), "1"), (range(4, 7), "2")],
        vec![(range(0, 0), "1"), (range(0, 3), "2")],
        vec![(range(0, 3), "1"), (range(4, 99), "2")],
    ] {
        let mut calls = 0;
        assert_eq!(
            engine
                .replace_many(engine.revision(), &runs, &mut |_| {
                    calls += 1;
                    Ok(())
                })
                .err(),
            Some(EditorError::InvalidRange),
            "{runs:?}"
        );
        assert_eq!(calls, 0);
        assert_eq!(engine.source_text(), "one two three");
    }
    // While text is marked, one run commits it as typing does; several
    // are refused.
    engine
        .compose(engine.revision(), range(13, 13), "か")
        .unwrap();
    assert_eq!(
        engine
            .replace_many(
                engine.revision(),
                &[(range(0, 3), "1"), (range(4, 7), "2")],
                &mut ok
            )
            .err(),
        Some(EditorError::CompositionActive)
    );
}

#[test]
fn collapsing_a_selection_never_leaves_the_caret_inside_a_grapheme() {
    let source = "ae\u{301}👩🏽\u{200d}💻z";
    let mut engine = Engine::open(source);
    // Byte 2 is between `e` and its accent; byte 8 is inside the emoji.
    select(&mut engine, 2, 8, Affinity::Backward);
    let moved = engine
        .move_caret(engine.revision(), CaretDirection::Backward)
        .unwrap();
    assert_eq!(moved.selection, range(1, 1));
    select(&mut engine, 2, 8, Affinity::Backward);
    let moved = engine
        .move_caret(engine.revision(), CaretDirection::Forward)
        .unwrap();
    assert_eq!(moved.selection, range(19, 19));
    // An edge already on a boundary stays where it is.
    select(&mut engine, 1, 4, Affinity::Backward);
    let moved = engine
        .move_caret(engine.revision(), CaretDirection::Forward)
        .unwrap();
    assert_eq!(moved.selection, range(4, 4));
    // A cluster longer than any chunk is one stop.
    let long = format!("ae{}z", "\u{301}".repeat(3000));
    let mut engine = Engine::open(&long);
    select(&mut engine, 3002, 4002, Affinity::Backward);
    let moved = engine
        .move_caret(engine.revision(), CaretDirection::Forward)
        .unwrap();
    assert_eq!(moved.selection, range(6002, 6002));
    typed(&mut engine, "!");
    assert!(engine.source_text().ends_with("!z"));
}
