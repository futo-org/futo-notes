//! The five properties, over random edit sequences on generated notes, and
//! (read-only, ignored by default) on the note directories in `LINES_COMPARE`.
//!
//! 1. Opening a note and saving it without an edit changes no bytes.
//! 2. Typing changes the note by exactly the typed bytes, at the position the
//!    caret maps to.
//! 3. Undo restores the exact bytes and selection; redo restores the edit.
//! 4. The reading and display after any edit equal those read from scratch.
//! 5. A position converted from text to display and back is unchanged, for
//!    every position not inside a hidden range; UTF-16 conversions never split
//!    a surrogate pair and never clamp.
//!
//! `TYPING_CASES` and `TYPING_SEED` set the number of notes and the seed.
mod checks;
mod generate;
mod real;
mod steps;

use super::super::line::Role;
use super::super::{read, Engine};
use crate::lines::{FenceRole, Kind, Reading, SpanKind, TableRole};
use crate::{
    Affinity, CaretDirection, DisplayOffset, DisplayRange, EditorError, InputAction, Revision,
    SourceEdit, SourceOffset, SourceRange,
};
use checks::*;
use generate::*;
use steps::*;

#[test]
fn the_five_properties_hold_over_random_edits() {
    let mut random = Random::from_env();
    for case in 0..cases() {
        let original = note(&mut random);
        // Property 1.
        let mut engine = Engine::open(&original);
        assert_eq!(engine.source_text(), original);
        check_fresh(&engine, &format!("case {case} opened {original:?}"));
        check_positions(&engine, &format!("case {case} opened {original:?}"));
        let mut model = Model::default();
        let mut view = engine.display_text();
        let mut steps = Vec::new();
        for _ in 0..24 {
            let done = step(&mut engine, &mut model, &mut view, &mut random);
            steps.push(done);
            let context = format!(
                "case {case} from {original:?} after {steps:?}, now {:?}",
                engine.source_text()
            );
            assert_eq!(view, engine.display_text(), "view change {context}");
            check_fresh(&engine, &context);
            check_positions(&engine, &context);
            assert!(engine.composition().is_none());
            assert_eq!(engine.check_revision(engine.revision()), Ok(()));
        }
        // Undo everything: the note is back to its bytes.
        while engine.undo(engine.revision(), &mut ok).unwrap().is_some() {}
        assert_eq!(
            engine.source_text(),
            original,
            "case {case} undone after {steps:?}"
        );
    }
}

#[test]
fn a_long_note_edits_without_walking_and_reads_as_fresh() {
    let mut random = Random(0x1234_5678_9abc_def1);
    let mut original = String::new();
    for line in 0..3000 {
        original.push_str(match line % 7 {
            0 => "- item **bold**\n",
            1 => "```\n",
            2 => "code\n",
            3 => "```\n",
            4 => "| a | b |\n",
            5 => "|---|---|\n",
            _ => "plain text\n",
        });
    }
    let mut engine = Engine::open(&original);
    let mut model = Model::default();
    let mut view = engine.display_text();
    for _ in 0..200 {
        step(&mut engine, &mut model, &mut view, &mut random);
    }
    assert_eq!(view, engine.display_text());
    check_fresh(&engine, "long note");
}

#[test]
fn large_pastes_and_deletions_keep_the_line_index_exact() {
    let mut random = Random(0x0bad_cafe_f00d_d00d);
    let block: String = (0..700).map(|line| format!("line {line} *x*\n")).collect();
    let mut engine = Engine::open(&block);
    for round in 0..40 {
        let source = engine.source_text();
        let mut a = random.below(source.len() + 1);
        let mut b = (a + random.below(source.len() / 2 + 1)).min(source.len());
        while !source.is_char_boundary(a) {
            a -= 1;
        }
        while !source.is_char_boundary(b) {
            b -= 1;
        }
        let pasted = match round % 4 {
            0 => block.clone(),
            1 => String::new(),
            2 => "```\n".to_owned() + &block[..block.len() / 3],
            _ => "x\n".repeat(random.below(300)),
        };
        let range = SourceRange {
            start: SourceOffset(a),
            end: SourceOffset(b),
        };
        let mut view = engine.display_text();
        if let Some(change) = engine
            .edit_source(engine.revision(), range, &pasted, &mut ok)
            .unwrap()
        {
            apply_view(&mut view, &change);
        }
        let mut want = source.clone();
        want.replace_range(a..b, &pasted);
        assert_eq!(engine.source_text(), want, "round {round}");
        assert_eq!(view, engine.display_text(), "round {round}");
        check_fresh(&engine, &format!("round {round}"));
    }
    while engine.undo(engine.revision(), &mut ok).unwrap().is_some() {}
    assert_eq!(engine.source_text(), block);
}

#[test]
fn stale_revisions_and_split_characters_are_refused() {
    let mut engine = Engine::open("日本");
    assert_eq!(
        engine.replace(
            Revision(1),
            DisplayRange::default(),
            "x",
            InputAction::Typing,
            &mut ok
        ),
        Err(EditorError::StaleRevision {
            expected: Revision(1),
            actual: Revision(0)
        })
    );
    let split = DisplayRange {
        start: DisplayOffset(1),
        end: DisplayOffset(1),
    };
    assert_eq!(
        engine.replace(Revision(0), split, "x", InputAction::Typing, &mut ok),
        Err(EditorError::InvalidRange)
    );
    assert_eq!(engine.source_text(), "日本");
    let _ = Role::Text;
}
