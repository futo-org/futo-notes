//! Typing and composition: exactly the bytes typed, one undo step, and a
//! refused acceptance that changes nothing.
use super::super::Engine;
use super::{ok, range, select, typed};
use crate::{Affinity, EditorError, InputAction, Revision};

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
fn typed_fence_keeps_language_on_opening_line() {
    for (source, caret, expected) in [("", 0, "```js"), ("\nb", 0, "```js\nb")] {
        let mut engine = Engine::open(source);
        select(&mut engine, caret, caret, Affinity::Backward);
        for ch in "```js".chars() {
            typed(&mut engine, &ch.to_string());
        }
        assert_eq!(engine.source_text(), expected);
        typed(&mut engine, "\n");
        assert_eq!(
            engine.source_text(),
            expected.replacen("```js", "```js\n", 1)
        );
    }
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
