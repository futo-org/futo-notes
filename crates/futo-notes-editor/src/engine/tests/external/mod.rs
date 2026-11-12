//! Taking in a change made outside the editor: no typed text and no outside
//! change is lost, and undo still restores exact bytes.
mod property;

use super::super::Engine;
use super::properties::check_fresh;
use super::{ok, range, select, typed};
use crate::{Affinity, EditorError, InlineFormat};

fn adopt(engine: &mut Engine, merged: &str) -> Result<(), EditorError> {
    let plan = engine.prepare_external(engine.revision(), merged, true)?;
    engine.adopt(plan, &mut ok)?;
    Ok(())
}

fn undo(engine: &mut Engine) -> bool {
    engine.undo(engine.revision(), &mut ok).unwrap().is_some()
}

fn redo(engine: &mut Engine) -> bool {
    engine.redo(engine.revision(), &mut ok).unwrap().is_some()
}

#[test]
fn an_outside_change_is_taken_in_and_undo_removes_only_local_edits() {
    let mut engine = Engine::open("first\n\nsecond\n");
    select(&mut engine, 7, 13, Affinity::Backward);
    typed(&mut engine, "LOCAL");
    let plan = engine
        .prepare_external(engine.revision(), "REMOTE\n\nLOCAL\n", true)
        .unwrap();
    // The view change covers only the changed window, not the whole note.
    let change = engine.adopt(plan, &mut ok).unwrap().unwrap();
    assert_eq!(change.edit.range.start.0, 0);
    assert_eq!(change.edit.removed, "first");
    assert_eq!(change.edit.inserted, "REMOTE");
    assert_eq!(engine.source_text(), "REMOTE\n\nLOCAL\n");
    assert_eq!(engine.selection(), range(13, 13));
    check_fresh(&engine, "adopted");
    // Undo restores the selection the local edit replaced, moved with the
    // outside change above it.
    assert!(undo(&mut engine));
    assert_eq!(engine.source_text(), "REMOTE\n\nsecond\n");
    assert_eq!(engine.selection(), range(8, 14));
    assert!(!undo(&mut engine));
    assert!(redo(&mut engine));
    assert_eq!(engine.source_text(), "REMOTE\n\nLOCAL\n");
    assert_eq!(engine.selection(), range(13, 13));
}

#[test]
fn a_redo_step_is_rebased_too() {
    let mut engine = Engine::open("one\n\ntwo\n");
    select(&mut engine, 3, 3, Affinity::Backward);
    typed(&mut engine, "!");
    assert!(undo(&mut engine));
    adopt(&mut engine, "zero\n\none\n\ntwo\n").unwrap();
    assert!(redo(&mut engine));
    assert_eq!(engine.source_text(), "zero\n\none!\n\ntwo\n");
    assert_eq!(engine.selection(), range(10, 10));
    assert!(undo(&mut engine));
    assert_eq!(engine.source_text(), "zero\n\none\n\ntwo\n");
    assert_eq!(engine.selection(), range(9, 9));
}

#[test]
fn an_outside_change_inside_the_edited_line_keeps_both_words() {
    let mut engine = Engine::open("alpha beta gamma\n");
    select(&mut engine, 5, 5, Affinity::Backward);
    typed(&mut engine, "X");
    let merged = "alphaX beta GAMMA\n";
    adopt(&mut engine, merged).unwrap();
    assert_eq!(engine.selection(), range(6, 6));
    assert!(undo(&mut engine));
    assert_eq!(engine.source_text(), "alpha beta GAMMA\n");
    assert!(redo(&mut engine));
    assert_eq!(engine.source_text(), merged);
}

#[test]
fn the_caret_pin_and_carried_formats_move_with_the_text() {
    let mut engine = Engine::open("a **b** c");
    // Typing at a source offset the display offset alone cannot name pins
    // the caret there.
    engine
        .edit_source(
            engine.revision(),
            crate::SourceRange {
                start: crate::SourceOffset(5),
                end: crate::SourceOffset(5),
            },
            "x",
            &mut ok,
        )
        .unwrap();
    assert_eq!(engine.source_text(), "a **bx** c");
    let pin = engine.pin.expect("a pinned caret");
    engine.formats = Some(vec![InlineFormat::Italic]);
    adopt(&mut engine, "top\n\na **bx** c").unwrap();
    assert_eq!(engine.pin, Some(pin + 5));
    assert_eq!(engine.formats, Some(vec![InlineFormat::Italic]));
    // The next typed character lands where it would have without the change.
    engine.formats = None;
    typed(&mut engine, "y");
    assert_eq!(engine.source_text(), "top\n\na **bxy** c");
}

#[test]
fn the_same_text_changes_nothing_and_keeps_history() {
    let mut engine = Engine::open("a\n");
    typed(&mut engine, "b");
    let revision = engine.revision();
    let plan = engine.prepare_external(revision, "ba\n", true).unwrap();
    assert_eq!(engine.adopt(plan, &mut ok).unwrap(), None);
    assert_eq!(engine.revision(), revision);
    assert!(engine.can_undo());
    let plan = engine.prepare_external(revision, "ba\n", false).unwrap();
    assert_eq!(engine.adopt(plan, &mut ok).unwrap(), None);
    assert!(engine.can_undo());
}

#[test]
fn an_ambiguous_history_refuses_before_anything_changes() {
    // Typing then deleting a word leaves the line as it was, so the merge of
    // the current text is clean, but undoing the deletion would bring the
    // word back into text the outside rewrote.
    let mut engine = Engine::open("hello world\n");
    select(&mut engine, 5, 5, Affinity::Backward);
    typed(&mut engine, " there");
    select(&mut engine, 5, 11, Affinity::Backward);
    engine
        .delete(engine.revision(), crate::CaretDirection::Backward, &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "hello world\n");
    let revision = engine.revision();
    let selection = engine.selection();
    assert_eq!(
        engine
            .prepare_external(revision, "hello big world\n", true)
            .err(),
        Some(EditorError::UnrepresentableFormat)
    );
    assert_eq!(engine.source_text(), "hello world\n");
    assert_eq!(engine.selection(), selection);
    assert_eq!(engine.revision(), revision);
    assert!(undo(&mut engine));
    assert_eq!(engine.source_text(), "hello there world\n");
    // Dropping history takes the change in and leaves nothing to undo.
    assert!(redo(&mut engine));
    let plan = engine
        .prepare_external(engine.revision(), "hello big world\n", false)
        .unwrap();
    engine.adopt(plan, &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "hello big world\n");
    assert!(!engine.can_undo() && !engine.can_redo());
    check_fresh(&engine, "dropped");
}

#[test]
fn history_over_the_bounds_refuses_and_dropping_it_still_adopts() {
    let mut engine = Engine::open("a\n");
    let big = "x".repeat(600 * 1024);
    typed(&mut engine, &big);
    select(&mut engine, 0, big.len(), Affinity::Backward);
    typed(&mut engine, "y");
    let local = engine.source_text();
    let merged = format!("{local}tail\n");
    assert_eq!(
        engine
            .prepare_external(engine.revision(), &merged, true)
            .err(),
        Some(EditorError::UnrepresentableFormat)
    );
    assert!(engine.can_undo());
    let plan = engine
        .prepare_external(engine.revision(), &merged, false)
        .unwrap();
    engine.adopt(plan, &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), merged);
    assert!(!engine.can_undo());
}

#[test]
fn history_bounds_count_entries_times_bytes() {
    // 300 KiB of text and 60 single-character entries: under 1 MiB, but
    // 60 times the estimate is over 16 MiB.
    let body = "z".repeat(300 * 1024);
    let mut engine = Engine::open(&body);
    for _ in 0..60 {
        typed(&mut engine, "\n");
    }
    let merged = format!("top\n{}", engine.source_text());
    assert_eq!(
        engine
            .prepare_external(engine.revision(), &merged, true)
            .err(),
        Some(EditorError::UnrepresentableFormat)
    );
}

#[test]
fn composition_refuses_both_kinds_of_adoption() {
    let mut engine = Engine::open("a\n");
    engine
        .compose(engine.revision(), range(1, 1), "か")
        .unwrap();
    for keep in [true, false] {
        assert_eq!(
            engine
                .prepare_external(engine.revision(), "b\n", keep)
                .err(),
            Some(EditorError::CompositionActive)
        );
    }
}

#[test]
fn a_prepared_adoption_is_refused_after_the_session_moves_on() {
    let mut engine = Engine::open("first\n\nsecond\n");
    select(&mut engine, 7, 13, Affinity::Backward);
    typed(&mut engine, "LOCAL");
    let merged = "REMOTE\n\nLOCAL\n";
    let plan = engine
        .prepare_external(engine.revision(), merged, true)
        .unwrap();
    select(&mut engine, 0, 0, Affinity::Forward);
    assert_eq!(
        engine.adopt(plan, &mut ok).err(),
        Some(EditorError::StaleClaim)
    );
    assert_eq!(engine.source_text(), "first\n\nLOCAL\n");
    let plan = engine
        .prepare_external(engine.revision(), merged, true)
        .unwrap();
    typed(&mut engine, "!");
    assert!(matches!(
        engine.adopt(plan, &mut ok),
        Err(EditorError::StaleRevision { .. })
    ));
    assert_eq!(engine.source_text(), "!first\n\nLOCAL\n");
    // A refused acceptance leaves everything as it was.
    let mut engine = Engine::open("a\n\nb\n\nc\n");
    typed(&mut engine, "x");
    let plan = engine
        .prepare_external(engine.revision(), "xa\n\nb\n\nC\n", true)
        .unwrap();
    let revision = engine.revision();
    assert_eq!(
        engine.adopt(plan, &mut |_| Err("disk".to_owned())).err(),
        Some(EditorError::Persistence("disk".to_owned()))
    );
    assert_eq!(engine.source_text(), "xa\n\nb\n\nc\n");
    assert_eq!(engine.revision(), revision);
    assert!(undo(&mut engine));
    assert_eq!(engine.source_text(), "a\n\nb\n\nc\n");
}

#[test]
fn front_matter_is_rewritten_only_when_history_is_dropped() {
    let mut engine = Engine::open("---\ntags: a\n---\nbody\n");
    typed(&mut engine, "new ");
    assert_eq!(engine.source_text(), "---\ntags: a\n---\nnew body\n");
    let merged = "---\ntags: b\n---\nnew body\n";
    assert_eq!(
        engine
            .prepare_external(engine.revision(), merged, true)
            .err(),
        Some(EditorError::UnrepresentableFormat)
    );
    // A `---` after the front matter is not metadata.
    assert_eq!(
        engine
            .prepare_external(
                engine.revision(),
                "---\ntags: a\n---\nnew body\n---\n",
                true
            )
            .map(|_| ()),
        Ok(())
    );
    // An outside change that closes an open `---` opens front matter.
    let mut plain = Engine::open("---\nbody\n");
    let end = plain.display_len();
    select(&mut plain, end, end, Affinity::Backward);
    typed(&mut plain, "x");
    assert_eq!(plain.source_text(), "---\nbody\nx");
    assert_eq!(
        plain
            .prepare_external(plain.revision(), "---\nbody\n---\nx", true)
            .err(),
        Some(EditorError::UnrepresentableFormat)
    );
    // A change after the front matter keeps history.
    adopt(&mut engine, "---\ntags: a\n---\nnew body\n\nmore\n").unwrap();
    assert!(undo(&mut engine));
    assert_eq!(engine.source_text(), "---\ntags: a\n---\nbody\n\nmore\n");
    assert!(redo(&mut engine));
    let plan = engine
        .prepare_external(engine.revision(), merged, false)
        .unwrap();
    engine.adopt(plan, &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), merged);
    // The caret stays out of the metadata.
    assert!(engine.selection().start.0 >= engine.metadata_end().unwrap());
    check_fresh(&engine, "front matter");
}

#[test]
fn a_large_note_reads_only_the_changed_lines_again() {
    let mut original = String::new();
    for line in 0..4000 {
        original.push_str(&format!("line {line} with **bold** text\n"));
    }
    let mut engine = Engine::open(&original);
    typed(&mut engine, "local ");
    let mut merged = engine.source_text();
    let at = merged.len() - "line 3999 with **bold** text\n".len();
    merged.insert_str(at, "outside ");
    let plan = engine
        .prepare_external(engine.revision(), &merged, true)
        .unwrap();
    let change = engine.adopt(plan, &mut ok).unwrap().unwrap();
    assert_eq!(change.edit.range.start.0, at);
    assert_eq!(change.edit.inserted, "outside ");
    assert!(
        change.work.parsed_source_bytes < 200,
        "read {} bytes again",
        change.work.parsed_source_bytes
    );
    assert_eq!(engine.source_text(), merged);
    check_fresh(&engine, "large");
    assert!(undo(&mut engine));
    assert_eq!(engine.source_text(), {
        let mut want = original.clone();
        want.insert_str(at - "local ".len(), "outside ");
        want
    });
}
