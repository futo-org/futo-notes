//! Remaining actual input mutations of a supplied typed word.
use super::*;
use futo_notes_editor::InputAction;
const WORD: &str = "<www.x.test/path";
fn typed() -> EditorSession {
    let mut editor = EditorSession::open("");
    editor
        .replace(Revision(0), range(0, 0), WORD, &mut |_| Ok(()))
        .unwrap();
    editor
}
fn literal(source: &str) {
    let fresh = EditorSession::open(source);
    assert_eq!(fresh.display_text(), source);
    assert!(fresh
        .project(Revision(0), range(0, source.len()))
        .unwrap()
        .links
        .is_empty());
}

#[test]
fn selected_typing_correction_is_a_valid_edit_of_the_supplied_word() {
    let corrected = "<www.x.test/math";
    literal(corrected);
    let mut editor = typed();
    editor.select(Revision(1), range(12, 13)).unwrap();
    let mut accepted = 0;
    editor
        .replace(Revision(1), range(12, 13), "m", &mut |_| {
            accepted += 1;
            Ok(())
        })
        .expect("actual typing over a selected path character must accept");
    assert_eq!(accepted, 1);
    assert_eq!(editor.source_text(), corrected);
    assert_eq!(editor.display_text(), corrected);
    editor.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), WORD);
    editor.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), corrected);
}

#[test]
fn backspace_and_retyped_equal_text_do_not_restore_the_retired_origin() {
    let shortened = "<www.x.test/pah";
    literal(shortened);
    let mut editor = typed();
    let mut accepted = 0;
    editor
        .replace(Revision(1), range(14, 15), "", &mut |_| {
            accepted += 1;
            Ok(())
        })
        .expect("a valid backspace inside a supplied word must accept");
    assert_eq!(accepted, 1);
    assert_eq!(editor.source_text(), shortened);
    editor
        .replace(Revision(2), range(14, 14), "t", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(editor.source_text(), WORD);
    let mut loaded = EditorSession::open(WORD);
    for (index, input) in [">", " "].into_iter().enumerate() {
        let at = 16 + index;
        editor.select(editor.revision(), range(at, at)).unwrap();
        editor
            .replace(editor.revision(), range(at, at), input, &mut |_| Ok(()))
            .unwrap();
        loaded
            .replace(loaded.revision(), range(at, at), input, &mut |_| Ok(()))
            .unwrap();
        assert_eq!(editor.source_text(), loaded.source_text());
        assert_eq!(editor.display_text(), loaded.display_text());
        assert!(editor
            .inspect_link(editor.revision(), range(1, 2))
            .unwrap()
            .is_none());
    }
}

#[test]
fn deleting_the_supplied_opener_accepts_the_independent_canonical_bare_uri() {
    let bare = "www.x.test/path";
    let canonical = EditorSession::open(bare);
    assert_eq!(canonical.display_text(), bare);
    let link = canonical
        .inspect_link(Revision(0), range(0, 1))
        .unwrap()
        .unwrap();
    assert_eq!(link.destination, "http://www.x.test/path");
    let mut editor = typed();
    let mut accepted = 0;
    editor
        .replace(Revision(1), range(0, 1), "", &mut |_| {
            accepted += 1;
            Ok(())
        })
        .expect("deleting a visible owned opener must remain a valid editor action");
    assert_eq!(accepted, 1);
    assert_eq!(editor.source_text(), bare);
    assert_eq!(editor.display_text(), bare);
    let fresh = EditorSession::open(&editor.source_text());
    assert_eq!(
        fresh
            .inspect_link(Revision(0), range(0, 1))
            .unwrap()
            .unwrap(),
        link
    );
    // This source proof does not prescribe a newly minted live timing identity.
    editor.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), WORD);
    editor.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), bare);
}

#[test]
fn explicit_equal_text_input_matches_the_existing_loaded_acceptance_contract() {
    let mut loaded = EditorSession::open(WORD);
    let mut baseline_accepts = 0;
    let baseline = loaded
        .replace_action(
            Revision(0),
            range(12, 13),
            "p",
            InputAction::Isolated,
            &mut |_| {
                baseline_accepts += 1;
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(baseline_accepts, 1);
    assert_eq!(loaded.source_text(), WORD);
    assert_eq!(loaded.revision(), Revision(1));
    let mut editor = typed();
    let mut accepts = 0;
    let actual = editor
        .replace_action(
            Revision(1),
            range(12, 13),
            "p",
            InputAction::Isolated,
            &mut |_| {
                accepts += 1;
                Ok(())
            },
        )
        .expect("an explicit equal-text command must retain its established acceptance contract");
    assert_eq!(accepts, baseline_accepts);
    assert_eq!(editor.source_text(), loaded.source_text());
    assert_eq!(editor.display_text(), loaded.display_text());
    assert_eq!(actual.selection, baseline.selection);
}
