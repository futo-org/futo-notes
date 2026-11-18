//! A block arriving in a list joins it (#442): strictly between two lines
//! of a list it becomes a sibling of the item below the slot, with that
//! item's indent, marker style and (for a task list) an unchecked box, and
//! numbered lists renumber where it left and where it landed. Outside any
//! list an item goes to the left margin as written, and an indented plain
//! line loses its indent.
use super::super::properties::checks::check_fresh;
use super::super::{ok, range};
use super::images::image;
use super::{line, slot};
use crate::{DisplayOffset, EditorSession};

/// What is pressed: the first line of a block, or the first photo.
#[derive(Clone, Copy)]
enum Press {
    Line(usize),
    Photo,
}
use Press::{Line, Photo};

fn press(session: &EditorSession, press: Press) -> DisplayOffset {
    match press {
        Line(index) => line(session, index),
        Photo => image(session, 0).start,
    }
}

/// Each (note, what is pressed, the boundary it lands on, the note after):
/// the move lands, reads as a fresh open, and one Undo restores the note.
fn check(cases: &[(&str, Press, usize, &str)]) {
    for &(before, pressed, to, after) in cases {
        let mut session = EditorSession::open(before);
        let revision = session.revision();
        let at = press(&session, pressed);
        session
            .move_block(revision, at, slot(&session, to), &mut ok)
            .unwrap()
            .unwrap_or_else(|| panic!("{before:?} to {to} was refused"));
        assert_eq!(session.source_text(), after, "{before:?} to {to}");
        check_fresh(session.engine(), &format!("moved {before:?} to {to}"));
        session.undo(session.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(session.source_text(), before, "undo {before:?} to {to}");
        check_fresh(session.engine(), &format!("undone {before:?} to {to}"));
    }
}

#[test]
fn a_block_inside_a_list_takes_the_indent_and_marker_of_the_item_below() {
    check(&[
        // A plain line becomes an item; a nested target gives it its indent.
        (
            "- a\n  - b\n  - c\nx",
            Line(3),
            2,
            "- a\n  - b\n  - x\n  - c",
        ),
        ("plain\n- a\n- b", Line(0), 2, "- a\n- plain\n- b"),
        // The note's last line moves up and takes the ending above it.
        ("- a\n- b\nplain", Line(2), 1, "- a\n- plain\n- b"),
        // Its children shift by the same whitespace; their markers stay.
        (
            "- a\n  - b\n- c\n  1. d\n- e",
            Line(2),
            1,
            "- a\n  - c\n    1. d\n  - b\n- e",
        ),
        // A nested item goes to the top level among top-level items.
        ("- a\n  - b\n- c\n- d", Line(1), 3, "- a\n- c\n- b\n- d"),
        // Tabs are copied as the item below spells them.
        (
            "- a\n\t- b\n\t- c\n- x",
            Line(3),
            2,
            "- a\n\t- b\n\t- x\n\t- c",
        ),
        // The marker style: the bullet character, a delimiter, a box.
        ("* a\n* b\n- x", Line(2), 1, "* a\n* x\n* b"),
        (
            "- [ ] a\n- [x] b\nplain",
            Line(2),
            1,
            "- [ ] a\n- [ ] plain\n- [x] b",
        ),
        (
            "- [ ] a\n- [ ] b\n1) n",
            Line(2),
            1,
            "- [ ] a\n- [ ] n\n- [ ] b",
        ),
        // A text that would read as a box under the new marker is escaped.
        ("- a\n- b\n1. [ ] n", Line(2), 1, "- a\n- \\[ ] n\n- b"),
        // CRLF: the moved last line takes the ending above it.
        ("* a\r\n* b\r\nx", Line(2), 1, "* a\r\n* x\r\n* b"),
        // The line below is a line under an item, not an item: the block
        // takes that line's indent and becomes an item there.
        ("- a\n  note\n- c\nx", Line(3), 1, "- a\n  - x\n  note\n- c"),
    ]);
}

#[test]
fn a_fence_under_an_item_moves_with_it_and_its_code_keeps_its_bytes() {
    check(&[
        // The fences keep their two columns past the item, spelled in
        // spaces when the item's whitespace is not theirs; code that does
        // not share the item's whitespace keeps its own.
        (
            "  - a\n\t~~~\nx\n\t~~~\n\n- p\n      - b",
            Line(0),
            6,
            "\n- p\n      - a\n        ~~~\nx\n        ~~~\n      - b",
        ),
        // An empty code line stays empty.
        (
            "- a\n  ~~~\n\n  ~~~\n\n- p\n\t- b",
            Line(0),
            6,
            "\n- p\n\t- a\n\t  ~~~\n\n\t  ~~~\n\t- b",
        ),
    ]);
}

#[test]
fn a_box_a_block_already_has_is_kept_with_its_state() {
    check(&[
        ("- a\n- b\n* [x] done", Line(2), 1, "- a\n- [x] done\n- b"),
        (
            "- [ ] a\n- [ ] b\n- [X] done",
            Line(2),
            1,
            "- [ ] a\n- [X] done\n- [ ] b",
        ),
        // A numbered item cannot hold a box: among numbers a task keeps its
        // own bullet, and the numbers around it stay.
        ("1. a\n2. b\n- [x] t", Line(2), 1, "1. a\n- [x] t\n2. b"),
    ]);
}

#[test]
fn numbered_lists_renumber_where_the_item_left_and_where_it_landed() {
    check(&[
        // Into a numbered list: it counts on from the item above, and the
        // items below that were counting on are bumped.
        (
            "1. a\n2. b\n3. c\n- x",
            Line(3),
            1,
            "1. a\n2. x\n3. b\n4. c",
        ),
        // First under its parent, it takes the number of the item below.
        (
            "1. p\n   1. a\n   2. b\nx",
            Line(3),
            1,
            "1. p\n   1. x\n   2. a\n   3. b",
        ),
        (
            "1. a\r\n2. b\r\n3. c\r\nx",
            Line(3),
            1,
            "1. a\r\n2. x\r\n3. b\r\n4. c",
        ),
        // Within one list, down and up.
        (
            "1. a\n2. b\n3. c\n4. d",
            Line(0),
            3,
            "1. b\n2. c\n3. a\n4. d",
        ),
        (
            "1. a\n2. b\n3. c\n4. d",
            Line(3),
            1,
            "1. a\n2. d\n3. b\n4. c",
        ),
        (
            "1. a\n2. b\n3. c\n4. d\n5. e",
            Line(3),
            1,
            "1. a\n2. d\n3. b\n4. c\n5. e",
        ),
        // From one list to another: the list it left closes up.
        (
            "1. a\n2. b\n3. c\n\n- x\n- y",
            Line(1),
            5,
            "1. a\n2. c\n\n- x\n- b\n- y",
        ),
        (
            "1. a\n2. b\n\n1. c\n2. d",
            Line(0),
            4,
            "1. b\n\n1. c\n2. a\n3. d",
        ),
        // A number written with leading zeros keeps its width.
        ("01. a\n02. b\nx", Line(2), 1, "01. a\n02. x\n03. b"),
        // A list numbered alike keeps its number.
        (
            "1. a\n1. b\n1. c\n- x",
            Line(3),
            2,
            "1. a\n1. b\n1. x\n1. c",
        ),
        (
            "- p\n  1. a\n  1. b\nx",
            Line(3),
            1,
            "- p\n  1. x\n  1. a\n  1. b",
        ),
        // Moved down into a child list, the list it left still closes up.
        (
            "1. a\n2. b\n  - child\n3. c",
            Line(0),
            2,
            "1. b\n  - a\n  - child\n2. c",
        ),
        // The walks follow the note as it was: `3. d` was never counting on
        // from `b`, and a line out of the list ended it there.
        (
            "1. a\n2. b\ncut\n3. d\n3. e",
            Line(2),
            1,
            "1. a\n2. cut\n3. b\n3. d\n3. e",
        ),
        // A number too long to count with is neither copied nor bumped.
        (
            "1. a\n9999999999999999999999999999999999999. b\nx",
            Line(2),
            1,
            "1. a\n2. x\n9999999999999999999999999999999999999. b",
        ),
    ]);
}

#[test]
fn numbers_the_move_does_not_rewrite_count_as_written() {
    // The children's numbers are theirs: the two subtrees trade places.
    // `5.` was not counting on from `1.`: the move does not rewrite it.
    check(&[
        ("1. a\n5. a", Line(0), 2, "5. a\n1. a"),
        (
            "- A\n  4. Apples\n- A\n  8. Apples\n- B",
            Line(0),
            4,
            "- A\n  8. Apples\n- A\n  4. Apples\n- B",
        ),
    ]);
}

#[test]
fn a_hand_numbered_list_not_counting_in_sequence_is_left_alone() {
    check(&[
        (
            "1. a\n5. b\n9. c\n- x",
            Line(3),
            1,
            "1. a\n2. x\n5. b\n9. c",
        ),
        (
            "1. a\n5. b\n9. c\n- y\n- z",
            Line(0),
            4,
            "5. b\n9. c\n- y\n- a\n- z",
        ),
    ]);
}

#[test]
fn an_item_dropped_outside_any_list_goes_to_the_left_margin_as_written() {
    check(&[
        // Its children shift with it.
        (
            "- a\n  - b\n    - c\n\npara",
            Line(1),
            5,
            "- a\n\npara\n- b\n  - c",
        ),
        ("- a\n  - [x] t\n\npara", Line(1), 0, "- [x] t\n- a\n\npara"),
        // A numbered item keeps its number; the list it left closes up.
        (
            "1. a\n2. b\n3. c\n\ntext",
            Line(1),
            5,
            "1. a\n2. c\n\ntext\n2. b",
        ),
        // Directly above a list's first item or below its last is outside.
        ("1. a\n2. b\n3. c", Line(2), 0, "3. c\n1. a\n2. b"),
    ]);
}

#[test]
fn a_block_that_is_no_list_item_or_plain_line_moves_as_written() {
    check(&[
        // A quote's first line keeps its markers whatever its indent.
        (">   - a\n> b\nz", Line(0), 3, "z\n>   - a\n> b"),
        (">   first\n> b\nz", Line(0), 3, "z\n>   first\n> b"),
    ]);
}

#[test]
fn a_plain_line_outside_a_list_stays_plain_and_loses_its_indent() {
    check(&[
        ("- a\n  note\n\nend", Line(1), 4, "- a\n\nend\nnote"),
        // Without its indent `# not` would be a heading: it is escaped.
        ("- a\n  # not\n\nend", Line(1), 4, "- a\n\nend\n\\# not"),
        // Directly above the first item or below the last it stays plain.
        ("x\n- a\n- b", Line(0), 3, "- a\n- b\nx"),
        ("- a\n- b\n\nx", Line(3), 0, "x\n- a\n- b\n"),
        ("- a\n- b\nx\n  y", Line(3), 0, "y\n- a\n- b\nx"),
    ]);
}

#[test]
fn a_photo_lifted_into_a_list_becomes_an_item_as_a_plain_line_would() {
    check(&[
        (
            "Nice!![](a.jpg)\n- [ ] x\n- [ ] y",
            Photo,
            2,
            "Nice!\n- [ ] x\n- [ ] ![](a.jpg)\n- [ ] y",
        ),
        (
            "1. a\n2. b\nhi ![](p.jpg)",
            Photo,
            1,
            "1. a\n2. ![](p.jpg)\n3. b\nhi ",
        ),
        // Outside a list it is a plain line of its own, as before.
        ("- a\n- b![](p.jpg)", Photo, 2, "- a\n- b\n![](p.jpg)"),
    ]);
}

#[test]
fn a_selection_of_exactly_a_line_that_becomes_an_item_travels_with_its_text() {
    // `plain` selected (display 4..9) lands as `- plain`, shown at 2..7.
    let mut session = EditorSession::open("- a\n- b\nplain");
    let revision = session.revision();
    session.select(revision, range(4, 9)).unwrap();
    session
        .move_block(revision, line(&session, 2), slot(&session, 1), &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), "- a\n- plain\n- b");
    assert_eq!(session.selection(), range(2, 7));
}

#[test]
fn a_caret_in_the_block_keeps_its_place_in_the_text_when_its_marker_changes() {
    // (note, the caret, the line pressed, the boundary, the caret after):
    // display offsets, where markers and boxes are hidden. A caret keeps its
    // character; one before the text lands at the text's start.
    for (before, caret, pressed, to, landed) in [
        // `pl|ain` becomes `- pl|ain`.
        ("- a\n- b\nplain", 6, 2, 1, 4),
        // `  no|te` loses its indent: `no|te`.
        ("- a\n  note\n\nend", 4, 1, 4, 9),
        // `- x|` taking a box keeps its character.
        ("- [ ] a\n- [ ] b\n1. x", 5, 2, 1, 3),
    ] {
        let mut session = EditorSession::open(before);
        let revision = session.revision();
        session.select(revision, range(caret, caret)).unwrap();
        let at = line(&session, pressed);
        session
            .move_block(revision, at, slot(&session, to), &mut ok)
            .unwrap()
            .unwrap_or_else(|| panic!("{before:?} to {to} was refused"));
        assert_eq!(session.selection(), range(landed, landed), "{before:?}");
        session.undo(session.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(session.selection(), range(caret, caret), "undo {before:?}");
    }
}
