//! The native block move: lookup, slots and the move cross the boundary in
//! display bytes, and the move is one accepted edit and one Undo step.
mod support;
use futo_notes_ffi::{EditorByteRange, EditorDisplayByteOffset, EditorSessionError, NoteStore};
use support::{path_string, TempTree};

fn at(offset: u64) -> EditorDisplayByteOffset {
    EditorDisplayByteOffset { offset }
}

#[test]
fn native_block_move_lifts_a_list_item_with_its_children_and_undo_restores_it() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let note = "a\n- b\n  - c\nd";
    store
        .create_note("list".into(), "".into(), note.into())
        .unwrap();
    let session = store.open_editor("list".into()).unwrap();
    // Display "a\nb\nc\nd": `b` at byte 2 lifts `b` and `c`.
    assert_eq!(
        session.block_at(0, at(2)).unwrap(),
        Some(EditorByteRange { start: 2, end: 6 })
    );
    assert_eq!(session.block_slots(0, at(2)).unwrap(), vec![at(0), at(7)]);
    // Not a slot: refused, nothing changes.
    assert!(session.move_block(0, at(2), at(4)).unwrap().is_none());
    let change = session.move_block(0, at(2), at(7)).unwrap().unwrap();
    assert_eq!(change.revision, 1);
    let mut display = "a\nb\nc\nd".to_owned();
    display.replace_range(
        change.range.start as usize..change.range.end as usize,
        &change.inserted,
    );
    assert_eq!(display, session.display_text().unwrap());
    assert_eq!(session.source_text().unwrap(), "a\nd\n- b\n  - c");
    assert!(matches!(
        session.move_block(0, at(0), at(7)),
        Err(EditorSessionError::StaleRevision {
            expected: 0,
            actual: 1
        })
    ));
    session.undo(1).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), note);
    session.checkpoint().unwrap();
    assert_eq!(store.read("list".into()).unwrap(), note);
}
