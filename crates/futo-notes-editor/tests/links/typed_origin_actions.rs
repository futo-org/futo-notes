//! Actual marked, OS and explicit multi-run commands on one known typed word.
use super::*;
use futo_notes_editor::DisplayReplacement;

fn typed_word() -> EditorSession {
    let mut editor = EditorSession::open("");
    editor
        .replace(
            Revision(0),
            range(0, 0),
            "<www.x.test/path",
            &mut |_| Ok(()),
        )
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
fn consume_caret_and_history(editor: &mut EditorSession, expected: &str) {
    assert_eq!(editor.source_text(), expected);
    assert_eq!(editor.display_text(), expected);
    assert_eq!(editor.selection(), range(expected.len(), expected.len()));
    let caret = editor.selection();
    editor
        .replace(Revision(2), caret, "!", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(editor.display_text(), format!("{expected}!"));
    editor.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), expected);
    editor.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), "<www.x.test/path");
    editor.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), expected);
    editor.redo(Revision(6), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.display_text(), format!("{expected}!"));
}

#[test]
fn unchanged_marked_word_preserves_original_typed_lifetime_without_acceptance() {
    let mut editor = typed_word();
    editor.compose(Revision(1), range(12, 13), "p").unwrap();
    assert!(editor
        .commit_composition(Revision(1), None, &mut |_| panic!(
            "unchanged marking appended"
        ))
        .unwrap()
        .is_none());
    assert_eq!(editor.revision(), Revision(1));
    assert_eq!(editor.source_text(), "<www.x.test/path");
    assert!(editor.composition().is_none());
    editor.select(Revision(1), range(16, 16)).unwrap();
    editor
        .replace(Revision(1), range(16, 16), ">", &mut |_| Ok(()))
        .unwrap();
    editor.select(Revision(2), range(0, 0)).unwrap();
    editor.select(Revision(2), range(17, 17)).unwrap();
    editor
        .replace(Revision(2), range(17, 17), " ", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(
        editor
            .inspect_link(Revision(3), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        "http://www.x.test/path"
    );
}

#[test]
fn changed_marked_end_insertion_accepts_literal_source_and_its_returned_caret() {
    let expected = "<www.x.test/pathz";
    literal(expected);
    let mut editor = typed_word();
    let marked = editor.compose(Revision(1), range(16, 16), "z").unwrap();
    assert_eq!(editor.source_text(), "<www.x.test/path");
    assert_eq!(editor.composition(), Some(&marked));
    let mut accepted = 0;
    let change = editor
        .commit_composition(Revision(1), None, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .expect("a valid marked insertion at a live word end must accept")
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(change.selection, range(17, 17));
    assert!(editor.composition().is_none());
    consume_caret_and_history(&mut editor, expected);
}

#[test]
fn authoritative_os_end_insertion_accepts_literal_source_and_its_returned_caret() {
    let expected = "<www.x.test/pathz";
    literal(expected);
    let mut editor = typed_word();
    let mut accepted = 0;
    let change = editor
        .replace_os(Revision(1), range(0, 16), expected, &[], &mut |_| {
            accepted += 1;
            Ok(())
        })
        .expect("a valid OS insertion at a live word end must accept")
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(change.selection, range(17, 17));
    consume_caret_and_history(&mut editor, expected);
}

#[test]
fn explicit_two_run_correction_keeps_each_actual_word_edit_and_final_caret() {
    let expected = "<www.x.test/mathz";
    literal(expected);
    let mut editor = typed_word();
    let mut accepted = 0;
    let change = editor
        .replace_many(
            Revision(1),
            &[
                DisplayReplacement {
                    range: range(12, 13),
                    inserted: "m".into(),
                },
                DisplayReplacement {
                    range: range(16, 16),
                    inserted: "z".into(),
                },
            ],
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        )
        .expect("both explicitly selected valid runs must accept together");
    assert_eq!(accepted, 1);
    assert_eq!(change.selection, range(17, 17));
    consume_caret_and_history(&mut editor, expected);
}
