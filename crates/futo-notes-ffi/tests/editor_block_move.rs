//! The native block move: lookup, slots and the move cross the boundary in
//! display bytes, and the move is one accepted edit and one Undo step.
mod support;
use futo_notes_ffi::{
    EditorBlockBoundary, EditorByteRange, EditorDisplayByteOffset, EditorLiftedBlock,
    EditorSessionError, NativeEditorSession, NoteStore,
};
use std::sync::Arc;
use support::{path_string, TempTree};

fn at(offset: u64) -> EditorDisplayByteOffset {
    EditorDisplayByteOffset { offset }
}

/// The boundary above the line shown from display byte `offset`.
fn above(offset: u64) -> EditorBlockBoundary {
    EditorBlockBoundary { offset, end: false }
}

/// The note's end, at display byte `offset`.
fn end(offset: u64) -> EditorBlockBoundary {
    EditorBlockBoundary { offset, end: true }
}

fn lines(start: u64, end: u64, to_end: bool) -> Option<EditorLiftedBlock> {
    Some(EditorLiftedBlock {
        range: EditorByteRange { start, end },
        to_end,
    })
}

/// The slots of a press at `press` anywhere in the note.
fn slots(session: &NativeEditorSession, revision: u64, press: u64) -> Vec<EditorBlockBoundary> {
    let len = session.display_text().unwrap().len() as u64;
    let whole = EditorByteRange { start: 0, end: len };
    session.block_slots(revision, at(press), whole).unwrap()
}

/// A session on a new note holding `text`.
fn open(tree: &TempTree, text: &str) -> (Arc<NoteStore>, Arc<NativeEditorSession>) {
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("note".into(), "".into(), text.into())
        .unwrap();
    let session = store.open_editor("note".into()).unwrap();
    (store, session)
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
    // Each item's marker is one U+FFFC of 3 bytes: the display is
    // "a\n\u{fffc}b\n\u{fffc}c\nd", and `b`'s line at byte 2 lifts `b`
    // and `c`, their marker units included.
    let shown = "a\n\u{fffc}b\n\u{fffc}c\nd";
    assert_eq!(session.display_text().unwrap(), shown);
    assert_eq!(session.block_at(0, at(2)).unwrap(), lines(2, 12, false));
    assert_eq!(slots(&session, 0, 2), vec![above(0), end(13)]);
    // Not a slot (inside the block): refused, nothing changes.
    assert!(session.move_block(0, at(2), above(7)).unwrap().is_none());
    let change = session.move_block(0, at(2), end(13)).unwrap().unwrap();
    assert_eq!(change.revision, 1);
    let mut display = shown.to_owned();
    display.replace_range(
        change.range.start as usize..change.range.end as usize,
        &change.inserted,
    );
    assert_eq!(display, session.display_text().unwrap());
    assert_eq!(session.source_text().unwrap(), "a\nd\n- b\n  - c");
    assert!(matches!(
        session.move_block(0, at(0), end(13)),
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

#[test]
fn native_block_move_offers_no_slot_the_blocks_own_bottom_edge_cannot_be_told_from() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("ends".into(), "".into(), "a\nb\n".into())
        .unwrap();
    let session = store.open_editor("ends".into()).unwrap();
    // `b` ends where the empty last line starts: byte 4 is its own edge, and
    // the note's end after that blank line is drawn there too.
    assert_eq!(slots(&session, 0, 2), vec![above(0)]);
    assert!(session.move_block(0, at(2), above(4)).unwrap().is_none());
    assert!(session.move_block(0, at(2), end(4)).unwrap().is_none());
    assert_eq!(session.source_text().unwrap(), "a\nb\n");
    assert!(matches!(session.undo(0), Ok(None)));
}

#[test]
fn native_block_move_lifts_a_photo_out_of_its_line_by_the_position_under_the_finger() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let note = "Nice!![](image-20261113-160256.jpg)\nnext";
    store
        .create_note("photo".into(), "".into(), note.into())
        .unwrap();
    let session = store.open_editor("photo".into()).unwrap();
    // The display is the source here: the photo shows its spelling, bytes 5..35.
    assert_eq!(session.block_at(0, at(5)).unwrap(), lines(5, 35, false));
    // On `Nice!` the whole line lifts, photo included.
    assert_eq!(session.block_at(0, at(2)).unwrap(), lines(0, 36, false));
    assert_eq!(slots(&session, 0, 2), vec![end(40)]);
    // The photo also lands on its own line's two edges.
    assert_eq!(slots(&session, 0, 5), vec![above(0), above(36), end(40)]);
    session.move_block(0, at(5), above(36)).unwrap().unwrap();
    assert_eq!(
        session.source_text().unwrap(),
        "Nice!\n![](image-20261113-160256.jpg)\nnext"
    );
    session.undo(1).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), note);
}

#[test]
fn native_block_move_tells_the_two_edges_of_an_empty_last_task_apart() {
    let tree = TempTree::new();
    let (store, session) = open(&tree, "a\nb\n- [ ] ");
    // The task shows its box as one U+FFFC of 3 bytes: the boundary above
    // it is at byte 4 and the note's end at byte 7.
    assert_eq!(session.display_text().unwrap(), "a\nb\n\u{fffc}");
    assert_eq!(session.block_at(0, at(4)).unwrap(), lines(4, 7, true));
    assert_eq!(slots(&session, 0, 4), vec![above(0), above(2)]);
    assert_eq!(slots(&session, 0, 0), vec![above(4), end(7)]);
    session.move_block(0, at(0), end(7)).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), "b\n- [ ] \na");
    session.undo(1).unwrap().unwrap();
    session.move_block(2, at(0), above(4)).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), "b\na\n- [ ] ");
    session.checkpoint().unwrap();
    assert_eq!(store.read("note".into()).unwrap(), "b\na\n- [ ] ");
}

#[test]
fn native_block_slots_are_asked_for_inside_a_display_range() {
    let tree = TempTree::new();
    let (_store, session) = open(&tree, "a\nb\nc\nd\ne");
    // `a` lands below each other line; bytes 3..6 hold the boundaries above
    // `c` (4) and `d` (6), both ends included.
    let near = EditorByteRange { start: 3, end: 6 };
    assert_eq!(
        session.block_slots(0, at(0), near).unwrap(),
        vec![above(4), above(6)]
    );
    // A range off the display is refused, never clamped; nothing changed.
    let past = EditorByteRange { start: 0, end: 10 };
    assert!(matches!(
        session.block_slots(0, at(0), past),
        Err(EditorSessionError::InvalidRange)
    ));
    assert_eq!(session.source_text().unwrap(), "a\nb\nc\nd\ne");
    assert!(matches!(session.undo(0), Ok(None)));
}

#[test]
fn native_block_move_reports_one_change_spanning_the_numbers_it_rewrites() {
    let tree = TempTree::new();
    let note = "1. a\n2. b\n3. c\n\n1. d\n2. e\n3. f";
    let (store, session) = open(&tree, note);
    // Each marker is one U+FFFC of 3 bytes, so each item shows 5 bytes and
    // `e`'s line starts at byte 21. `a` dropped above `e` joins the second list as its second item: the first list
    // closes up and `e` and `f` count on, edits far apart in one change.
    let before = session.display_text().unwrap();
    let change = session.move_block(0, at(0), above(21)).unwrap().unwrap();
    let after = "1. b\n2. c\n\n1. d\n2. a\n3. e\n4. f";
    assert_eq!(session.source_text().unwrap(), after);
    let mut display = before;
    display.replace_range(
        change.range.start as usize..change.range.end as usize,
        &change.inserted,
    );
    assert_eq!(display, session.display_text().unwrap());
    // The renderer restyles the projection: it must carry every rewritten
    // marker, `b`'s at the top and `f`'s at the bottom included, though
    // the displayed text changes only through `e`'s marker unit (21..24).
    assert!(change.range.end <= 24, "{:?}", change.range);
    let markers: Vec<_> = change
        .projection
        .blocks
        .iter()
        .filter_map(|block| block.list.as_ref().map(|list| list.marker.clone()))
        .collect();
    assert_eq!(markers, ["1.", "2.", "1.", "2.", "3.", "4."]);
    assert_eq!(change.projection.range.start, 0);
    assert_eq!(change.projection.range.end, display.len() as u64);
    session.undo(1).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), note);
    session.checkpoint().unwrap();
    assert_eq!(store.read("note".into()).unwrap(), note);
}
