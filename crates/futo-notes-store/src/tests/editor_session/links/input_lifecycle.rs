//! One common typed-input lifecycle through both history stacks.
use super::*;
use futo_notes_editor::{Affinity, EditorSession};
const FOREIGN: &str = "<[www.x.test/path](<http://www.x.test/path>)>\n\n";
const FOREIGN_VIEW: &str = "<www.x.test/path>\n\n";
const WORD: &str = "<www.x.test/";
const MIXED: &str = "prefix <www.x.test/path> ";

fn mark_unchanged(editor: &mut crate::StoreEditorSession<'_>) {
    let base = FOREIGN_VIEW.len();
    editor
        .select_with_affinity(
            editor.revision(),
            range(base + WORD.len(), base + WORD.len()),
            Affinity::Backward,
        )
        .unwrap();
    let mark = editor
        .compose(editor.revision(), range(base + 1, base + 2), "w")
        .unwrap();
    assert_eq!(editor.composition(), Some(mark));
}
fn mixed(editor: &mut crate::StoreEditorSession<'_>) -> Result<(), EditorStoreError> {
    let at = FOREIGN_VIEW.len() + WORD.len();
    editor
        .replace(editor.revision(), range(at, at), MIXED)
        .map(|_| ())
}
fn undo_probe(editor: &mut crate::StoreEditorSession<'_>, original: &str) {
    editor.undo(editor.revision()).unwrap().unwrap();
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), original);
    assert!(editor
        .inspect_link(
            editor.revision(),
            range(FOREIGN_VIEW.len() + 1, FOREIGN_VIEW.len() + 2)
        )
        .unwrap()
        .is_none());
}

#[test]
fn mixed_input_preserves_marked_origin_foreign_link_and_both_history_stacks() {
    let canonical = EditorSession::open(&format!(
        "{FOREIGN}{WORD}prefix <[www.x.test/path](<http://www.x.test/path>)> "
    ));
    let expected_text = format!("{FOREIGN_VIEW}{WORD}{MIXED}");
    assert_eq!(canonical.display_text(), expected_text);
    let expected = canonical
        .project(Revision(0), range(0, expected_text.len()))
        .unwrap()
        .links;
    assert_eq!(expected.len(), 2);
    assert_eq!(expected[0].destination, expected[1].destination);
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "input-lifecycle", FOREIGN).unwrap();
    let mut editor = store.open_editor("input-lifecycle").unwrap();
    let base = FOREIGN_VIEW.len();
    let at = base + WORD.len();
    editor
        .replace(Revision(0), range(base, base), WORD)
        .unwrap();
    let original = editor.source_text();
    assert_eq!(original, format!("{FOREIGN}{WORD}"));
    // Create a genuine queued Redo before failure, then restore the old
    // live identity by Undo rather than by equal-text input.
    editor
        .replace_action(
            Revision(1),
            range(base + 5, base + 6),
            "y",
            futo_notes_editor::InputAction::Isolated,
        )
        .unwrap();
    editor.undo(Revision(2)).unwrap().unwrap();
    assert_eq!(editor.source_text(), original);
    mark_unchanged(&mut editor);
    assert_eq!(store.read("input-lifecycle").unwrap(), FOREIGN);
    editor.cancel_composition(editor.revision()).unwrap();
    // First observe the surviving CURRENT origin; a dropped field would
    // leave this new WWW closer unconverted on fresh canonical reopen.
    editor
        .replace(editor.revision(), range(at, at), ">")
        .unwrap();
    let fresh = EditorSession::open(&editor.source_text());
    let closed = fresh
        .inspect_link(Revision(0), range(base + 1, base + 2))
        .unwrap()
        .unwrap();
    assert_eq!(closed.destination, "http://www.x.test/");
    editor
        .select_with_affinity(editor.revision(), range(0, 0), Affinity::Forward)
        .unwrap();
    editor
        .select_with_affinity(editor.revision(), range(at + 1, at + 1), Affinity::Forward)
        .unwrap();
    editor
        .replace(editor.revision(), range(at + 1, at + 1), " ")
        .unwrap();
    assert_eq!(
        editor
            .inspect_link(editor.revision(), range(base + 1, base + 2))
            .unwrap()
            .unwrap()
            .destination,
        "http://www.x.test/"
    );
    let probe_source = editor.source_text();
    undo_probe(&mut editor, &original);
    // Repeat the same failed intent with the probe's two real Redo groups
    // queued. Their subsequent actual replay proves no failed entry was
    // recorded and neither stack was silently discarded.
    mark_unchanged(&mut editor);
    editor.cancel_composition(editor.revision()).unwrap();
    editor.redo(editor.revision()).unwrap().unwrap();
    editor.redo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), probe_source);
    undo_probe(&mut editor, &original);
    mark_unchanged(&mut editor);
    let revision = editor.revision();
    mixed(&mut editor).unwrap();
    assert_eq!(editor.revision(), Revision(revision.0 + 1));
    assert!(editor.composition().is_none());
    assert_eq!(editor.display_text(), expected_text);
    assert_eq!(
        editor.selection(),
        range(expected_text.len(), expected_text.len())
    );
    assert_eq!(
        editor
            .project(editor.revision(), range(0, expected_text.len()))
            .unwrap()
            .links,
        expected
    );
    let saved = editor.source_text();
    assert!(saved.starts_with(FOREIGN));
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), original);
    editor.redo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), saved);
    assert!(editor.redo(editor.revision()).unwrap().is_none());
    editor.undo(editor.revision()).unwrap().unwrap();
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), FOREIGN);
    assert!(editor.undo(editor.revision()).unwrap().is_none());
    editor.redo(editor.revision()).unwrap().unwrap();
    editor.redo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), saved);
    editor.checkpoint().unwrap();
    drop(editor);
    let mut recovered = store.open_editor("input-lifecycle").unwrap();
    // The save appended the note's final line ending.
    let saved = format!("{saved}\n");
    assert_eq!(recovered.source_text(), saved);
    assert_eq!(recovered.display_text(), format!("{expected_text}\n"));
    assert_eq!(
        recovered
            .project(recovered.revision(), range(0, expected_text.len()))
            .unwrap()
            .links,
        expected
    );
    assert!(recovered.undo(recovered.revision()).unwrap().is_none());
    recovered.checkpoint().unwrap();
    assert_eq!(store.read("input-lifecycle").unwrap(), saved);
}

#[test]
fn completed_marked_https_preserves_overlay_redo_foreign_link() {
    completed_marked_https_case("<HTTPS://x.test/PaTh> ", "<<HTTPS://x.test/PaTh>> ");
}
#[test]
fn completed_marked_lf_uses_the_same_atomic_owner_and_canonical_source() {
    completed_marked_https_case("<HTTPS://x.test/PaTh>\n", "<<HTTPS://x.test/PaTh>>\n");
}
fn completed_marked_https_case(input: &str, canonical: &str) {
    let standard = EditorSession::open(&format!("{FOREIGN}{canonical}"));
    let shown = format!("{FOREIGN_VIEW}{input}");
    assert_eq!(standard.display_text(), shown);
    let expected = standard
        .project(Revision(0), range(0, shown.len()))
        .unwrap()
        .links;
    assert_eq!(expected.len(), 2);
    assert_eq!(expected[1].destination, "HTTPS://x.test/PaTh");
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "completed-input", FOREIGN).unwrap();
    let mut editor = store.open_editor("completed-input").unwrap();
    let at = FOREIGN_VIEW.len();
    editor
        .replace_action(
            Revision(0),
            range(at, at),
            "!",
            futo_notes_editor::InputAction::Isolated,
        )
        .unwrap();
    editor.undo(Revision(1)).unwrap().unwrap();
    let base = editor.revision();
    editor.compose(base, range(at, at), input).unwrap();
    assert_eq!(store.read("completed-input").unwrap(), FOREIGN);
    // Failed commit preserved its overlay and the genuinely queued Redo.
    editor.cancel_composition(base).unwrap();
    editor.redo(base).unwrap().unwrap();
    assert_eq!(editor.display_text(), format!("{FOREIGN_VIEW}!"));
    editor.undo(editor.revision()).unwrap().unwrap();
    editor
        .compose(editor.revision(), range(at, at), input)
        .unwrap();
    let revision = editor.revision();
    editor.commit_composition(revision, None).unwrap().unwrap();
    assert_eq!(editor.revision(), Revision(revision.0 + 1));
    assert!(editor.composition().is_none());
    assert_eq!(editor.display_text(), shown);
    assert_eq!(editor.selection(), range(shown.len(), shown.len()));
    assert_eq!(
        editor
            .project(editor.revision(), range(0, shown.len()))
            .unwrap()
            .links,
        expected
    );
    let saved = editor.source_text();
    assert!(saved.starts_with(FOREIGN));
    let fresh = EditorSession::open(&saved);
    assert_eq!(fresh.display_text(), shown);
    assert_eq!(
        fresh
            .project(Revision(0), range(0, shown.len()))
            .unwrap()
            .links,
        expected
    );
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), FOREIGN);
    editor.redo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), saved);
    assert!(editor.redo(editor.revision()).unwrap().is_none());
    editor.checkpoint().unwrap();
    drop(editor);
    let mut recovered = store.open_editor("completed-input").unwrap();
    // The save appended the note's final line ending, if it had none.
    let (saved, saved_view) = saved_forms(&saved, &shown);
    assert_eq!(recovered.source_text(), saved);
    assert_eq!(recovered.display_text(), saved_view);
    assert_eq!(
        recovered
            .project(recovered.revision(), range(0, shown.len()))
            .unwrap()
            .links,
        expected
    );
    assert!(recovered.composition().is_none());
    assert!(recovered.undo(recovered.revision()).unwrap().is_none());
    recovered.checkpoint().unwrap();
    assert_eq!(store.read("completed-input").unwrap(), saved);
}

#[test]
fn paragraph_lf_preserves_the_actual_unfinished_word_for_history() {
    const TYPED: &str = "<www.x.test/path";
    let shown = format!("{FOREIGN_VIEW}{TYPED}\n");
    let standard = EditorSession::open(&format!(
        "{FOREIGN}<[www.x.test/path](<http://www.x.test/path>)\n"
    ));
    assert_eq!(standard.display_text(), shown);
    let expected = standard
        .project(Revision(0), range(0, shown.len()))
        .unwrap()
        .links;
    assert_eq!(expected.len(), 2);
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "paragraph-ending", FOREIGN).unwrap();
    let mut editor = store.open_editor("paragraph-ending").unwrap();
    let start = FOREIGN_VIEW.len();
    let at = start + TYPED.len();
    assert!(shown.is_ascii());
    let native = futo_notes_editor::DisplayUtf16Range {
        start: futo_notes_editor::DisplayUtf16Offset(at),
        end: futo_notes_editor::DisplayUtf16Offset(at),
    };
    editor
        .replace(Revision(0), range(start, start), TYPED)
        .unwrap();
    let original = editor.source_text();
    editor
        .replace_action(
            Revision(1),
            range(at, at),
            "z",
            futo_notes_editor::InputAction::Isolated,
        )
        .unwrap();
    editor.undo(Revision(2)).unwrap().unwrap();
    editor
        .select_with_affinity(editor.revision(), range(at, at), Affinity::Backward)
        .unwrap();
    assert_eq!(store.read("paragraph-ending").unwrap(), FOREIGN);
    // The failed key did not consume the preexisting Redo or its old word.
    editor.redo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.display_text(), format!("{FOREIGN_VIEW}{TYPED}z"));
    editor.undo(editor.revision()).unwrap().unwrap();
    editor
        .paragraph_key_utf16(
            editor.revision(),
            native,
            futo_notes_editor::ParagraphKey::Enter,
        )
        .unwrap()
        .unwrap();
    assert_eq!(editor.display_text(), shown);
    assert_eq!(editor.selection(), range(shown.len(), shown.len()));
    assert_eq!(
        editor
            .project(editor.revision(), range(0, shown.len()))
            .unwrap()
            .links,
        expected
    );
    let saved = editor.source_text();
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), original);
    assert!(editor
        .inspect_link(editor.revision(), range(start + 1, start + 2))
        .unwrap()
        .is_none());
    editor.redo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), saved);
    editor.checkpoint().unwrap();
    drop(editor);
    let mut recovered = store.open_editor("paragraph-ending").unwrap();
    assert_eq!(recovered.source_text(), saved);
    assert_eq!(recovered.display_text(), shown);
    assert_eq!(
        recovered
            .project(recovered.revision(), range(0, shown.len()))
            .unwrap()
            .links,
        expected
    );
    assert!(recovered.undo(recovered.revision()).unwrap().is_none());
    recovered.checkpoint().unwrap();
    assert_eq!(store.read("paragraph-ending").unwrap(), saved);
}
