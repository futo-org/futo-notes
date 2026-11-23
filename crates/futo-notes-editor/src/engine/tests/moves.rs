//! Block movement through the session: which lines lift together, where
//! they may land, and the move itself as one exact Undo step (#311, #440).
use super::properties::checks::check_fresh;
use super::{ok, range};
use crate::{BlockBoundary, DisplayOffset, EditorError, EditorSession, LiftedBlock, Revision};
use std::ops::Range;

mod arrival;
mod corpus;
mod images;
mod markers;
mod selection;
mod slots;
mod trial;

/// The display offset where source line `index` starts (the note's display
/// end for the line count): what a renderer has under a finger.
fn line(session: &EditorSession, index: usize) -> DisplayOffset {
    DisplayOffset(session.engine().store.before(index).display)
}

fn lines(session: &EditorSession, range: Range<usize>) -> crate::DisplayRange {
    let (start, end) = (line(session, range.start), line(session, range.end));
    crate::DisplayRange { start, end }
}

/// What lifting source lines `range` reports.
fn lifted(session: &EditorSession, range: Range<usize>) -> LiftedBlock {
    let to_end = range.end == session.engine().line_count();
    LiftedBlock {
        range: lines(session, range),
        to_end,
    }
}

/// Boundary `index` (above source line `index`; the line count is the
/// note's end) as a renderer names it.
fn slot(session: &EditorSession, index: usize) -> BlockBoundary {
    BlockBoundary {
        at: line(session, index),
        end: index == session.engine().line_count(),
    }
}

/// The slots for a press at `at`, anywhere in the note.
fn slots(session: &mut EditorSession, at: DisplayOffset) -> Vec<BlockBoundary> {
    let whole = range(0, session.display_text().len());
    let revision = session.revision();
    session.block_slots(revision, at, whole).unwrap().slots
}

/// A line, the lines it lifts, and the boundaries they may land on.
type Lifts = (usize, Option<Range<usize>>, &'static [usize]);

const NOTE: &str = "---\ntags: a\n---\n# Title\nplain\n- a\n  - b\n  note\n- c\n\n> q\n> - r\n```\ncode\n```\n| h |\n|---|\n| x |\n---\nlast";

#[test]
fn every_block_kind_lifts_its_lines_and_lands_only_on_its_slots() {
    let mut session = EditorSession::open(NOTE);
    let revision = session.revision();
    // (line, the lines that lift, the boundaries they may land on: boundary
    // `b` is above line `b`, and 20 is the note's end). Frame lines (front
    // matter's `---`, fences) show nothing of their own: a renderer reaches a
    // hidden opening line at the line it shows before, and a closing line
    // not at all.
    let cases: [Lifts; 18] = [
        (0, None, &[]),
        (1, None, &[]),
        (3, Some(3..4), &[5, 9, 10, 12, 15, 18, 19, 20]),
        (4, Some(4..5), &[3, 6, 7, 8, 9, 10, 12, 15, 18, 19, 20]),
        (5, Some(5..8), &[3, 4, 9, 10, 12, 15, 18, 19, 20]),
        (6, Some(6..7), &[3, 4, 5, 8, 9, 10, 12, 15, 18, 19, 20]),
        (7, Some(7..8), &[3, 4, 5, 6, 9, 10, 12, 15, 18, 19, 20]),
        (8, Some(8..9), &[3, 4, 5, 6, 7, 10, 12, 15, 18, 19, 20]),
        (9, None, &[]),
        (10, Some(10..12), &[3, 4, 5, 9, 15, 18, 19, 20]),
        (11, Some(10..12), &[3, 4, 5, 9, 15, 18, 19, 20]),
        (12, Some(12..15), &[3, 4, 5, 9, 10, 18, 19, 20]),
        (13, Some(12..15), &[3, 4, 5, 9, 10, 18, 19, 20]),
        (15, Some(15..18), &[3, 4, 5, 9, 10, 12, 19, 20]),
        (16, Some(15..18), &[3, 4, 5, 9, 10, 12, 19, 20]),
        (17, Some(15..18), &[3, 4, 5, 9, 10, 12, 19, 20]),
        (18, Some(18..19), &[3, 4, 5, 9, 10, 12, 15, 20]),
        (19, Some(19..20), &[3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 18]),
    ];
    for (index, lifts, slots) in cases {
        let at = line(&session, index);
        let expected = lifts.map(|lines| lifted(&session, lines));
        assert_eq!(
            session.block_at(revision, at).unwrap(),
            expected,
            "line {index}"
        );
        let want: Vec<_> = slots.iter().map(|&b| slot(&session, b)).collect();
        assert_eq!(self::slots(&mut session, at), want, "line {index}");
    }
    // An unclosed fence is code to the note's end: it lifts nothing, nor
    // does an item whose lines run into it, and nothing lands after it.
    let session = EditorSession::open("a\n```\ncode");
    assert_eq!(
        session.block_at(Revision(0), line(&session, 2)).unwrap(),
        None
    );
    let session = EditorSession::open("b\n- a\n  ```\n  code");
    assert_eq!(
        session.block_at(Revision(0), line(&session, 1)).unwrap(),
        None
    );
    // A quote is no list item or plain line, even when it is one line or
    // starts with an item: it lands beside a list, never inside one.
    for note in ["- a\n- b\n\n> q", "- a\n- b\n\n> - q"] {
        let mut session = EditorSession::open(note);
        let at = line(&session, 3);
        let want = vec![slot(&session, 0), slot(&session, 2)];
        assert_eq!(slots(&mut session, at), want, "{note:?}");
    }
    // After a note's last line ending, the empty last line has no width:
    // the boundary above it is the one slot at the display's end.
    let mut session = EditorSession::open("a\nb\n");
    let want = vec![slot(&session, 2)];
    assert_eq!(slots(&mut session, DisplayOffset(0)), want);
    let mut session = EditorSession::open("a\n```\ncode");
    assert_eq!(slots(&mut session, DisplayOffset(0)), vec![]);
}

#[test]
fn a_boundary_a_renderer_cannot_tell_from_the_blocks_own_edge_is_no_slot() {
    // The empty last line after a final line ending is blank and has no
    // width, so the note's end is drawn where the boundary above it is. For
    // the line above it, that is its own bottom edge. (note, the display
    // offsets the last line's block may land on, its own edges, then the
    // note's end at the same place.)
    for (note, slots, edges) in [("a\nb\n", vec![0], (2, 4)), ("a\n", vec![], (0, 2))] {
        let mut session = EditorSession::open(note);
        let revision = session.revision();
        let at = DisplayOffset(edges.0);
        let want: Vec<_> = slots
            .into_iter()
            .map(|at| BlockBoundary {
                at: DisplayOffset(at),
                end: false,
            })
            .collect();
        assert_eq!(self::slots(&mut session, at), want, "{note:?}");
        for (edge, end) in [(edges.0, false), (edges.1, false), (edges.1, true)] {
            let to = BlockBoundary {
                at: DisplayOffset(edge),
                end,
            };
            let moved = session.move_block(revision, at, to, &mut ok);
            assert_eq!(moved.unwrap(), None, "{note:?} to {to:?}");
            assert_eq!(session.source_text(), note);
            assert_eq!(session.revision(), revision);
            assert!(!session.toolbar_state().can_undo, "{note:?}");
        }
    }
}

#[test]
fn a_move_changes_only_where_the_block_is_and_one_undo_restores_it() {
    // (note, a line of the block, the boundary it lands on, the note after).
    for (before, from, to, after) in [
        ("a\nb\nc", 0, 2, "b\na\nc"),
        // A list item moves with its children; to the last line, its last
        // ending goes to the line that was last.
        ("- a\n  - b\n- c\nend", 0, 4, "- c\nend\n- a\n  - b"),
        // From the last line, it takes the ending of the line above it.
        ("x\n- a\n  - b\n- c", 3, 1, "x\n- c\n- a\n  - b"),
        ("p\n> q\n> - r\ns", 2, 0, "> q\n> - r\np\ns"),
        ("a\n```\ncode\n```\nb", 2, 5, "a\nb\n```\ncode\n```"),
        ("| h |\n|---|\n| x |\n\nb", 1, 5, "\nb\n| h |\n|---|\n| x |"),
        ("a\r\nb", 0, 2, "b\r\na"),
        ("a\n\nb", 0, 3, "\nb\na"),
        // Only list items' numbers are left out when a move is judged a
        // change: code that differs only in its digits still moves.
        (
            "```\n1) a\n```\n```\n2) a\n```",
            3,
            0,
            "```\n2) a\n```\n```\n1) a\n```",
        ),
    ] {
        let mut session = EditorSession::open(before);
        let revision = session.revision();
        let change = session
            .move_block(revision, line(&session, from), slot(&session, to), &mut ok)
            .unwrap()
            .unwrap_or_else(|| panic!("{before:?} line {from} to {to} was refused"));
        assert_eq!(session.source_text(), after, "{before:?}");
        assert_eq!(change.revision, Revision(revision.0 + 1));
        check_fresh(session.engine(), &format!("moved {before:?}"));
        session.undo(session.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(session.source_text(), before, "undo {before:?}");
        check_fresh(session.engine(), &format!("undone {before:?}"));
    }
}

#[test]
fn the_caret_moves_with_the_block_it_is_in_and_stays_with_any_other_line() {
    let mut session = EditorSession::open("ab\ncd\nef");
    // The caret after `a` on the moved line, then after `c` on a line it passes.
    for (caret, landed) in [(1, 4), (4, 1)] {
        let revision = session.revision();
        session.select(revision, range(caret, caret)).unwrap();
        session
            .move_block(revision, line(&session, 0), slot(&session, 2), &mut ok)
            .unwrap()
            .unwrap();
        assert_eq!(session.selection(), range(landed, landed));
        session.undo(session.revision(), &mut ok).unwrap();
        assert_eq!(session.source_text(), "ab\ncd\nef");
    }
}

#[test]
fn a_selection_covering_the_block_moves_whole_with_it() {
    // (note, the selection, a line of the block, the boundary it lands on,
    // the note after, the selection after). Each branch of the move is one:
    // a line passed, to the note's end, from the note's end.
    for (before, selected, from, to, after, landed) in [
        // The line ending is part of the selection, so it travels too.
        ("a\nb\nc", (0, 2), 0, 2, "b\na\nc", (2, 4)),
        ("a\nb\nc", (2, 4), 1, 0, "b\na\nc", (0, 2)),
        ("a\nb\nc", (1, 2), 0, 2, "b\na\nc", (3, 4)),
        // To the end its ending stays behind, on the line that was last.
        ("a\nb\nc", (0, 2), 0, 3, "b\nc\na", (4, 5)),
        ("a\r\nb\r\nc", (0, 3), 0, 3, "b\r\nc\r\na", (6, 7)),
        // The last line has no ending to carry.
        ("a\nb\nc", (4, 5), 2, 0, "c\na\nb", (0, 1)),
        ("a\nb\nc", (4, 5), 2, 1, "a\nc\nb", (2, 3)),
        // Only a selection from inside the block: a caret at its end, or a
        // selection reaching it from above, stays with the line below.
        ("a\nb\nc", (2, 2), 0, 2, "b\na\nc", (0, 0)),
        ("a\nb\nc", (0, 4), 1, 3, "a\nc\nb", (0, 2)),
    ] {
        let mut session = EditorSession::open(before);
        let revision = session.revision();
        session
            .select(revision, range(selected.0, selected.1))
            .unwrap();
        session
            .move_block(revision, line(&session, from), slot(&session, to), &mut ok)
            .unwrap()
            .unwrap_or_else(|| panic!("{before:?} line {from} to {to} was refused"));
        assert_eq!(session.source_text(), after, "{before:?}");
        assert_eq!(session.selection(), range(landed.0, landed.1), "{before:?}");
        session.undo(session.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(session.source_text(), before, "undo {before:?}");
        assert_eq!(
            session.selection(),
            range(selected.0, selected.1),
            "undo {before:?}"
        );
    }
}

#[test]
fn a_refused_move_changes_nothing() {
    // (note, a line, a boundary): moves that are no move, and moves the
    // guard cancels because a line would read as another kind of block,
    // which are therefore no slot either.
    for (before, from, to) in [
        // A blank line lifts nothing; a block's own edge is no slot.
        ("a\n\nb", 1, 0),
        ("a\nb", 0, 1),
        // A plain `|---|` under a pipe line makes it a table header.
        ("| a |\n\n|---|", 2, 1),
        // A `---` reaching line 1 opens front matter with a later `---`.
        ("a\n---\nb\n---\nc", 0, 4),
        // Out of its list `|---|` loses its indent, and under `| h |` it
        // would make that a table header: no `\` keeps the line above.
        ("- p\n  |---|\n\n| h |\nend", 1, 4),
        // A move that would change only the numbers it rewrites is no move.
        ("1. a\n2. a\n3. b", 0, 2),
    ] {
        let mut session = EditorSession::open(before);
        let revision = session.revision();
        let (at, to) = (line(&session, from), slot(&session, to));
        assert!(!slots(&mut session, at).contains(&to), "{before:?}");
        let moved = session.move_block(revision, at, to, &mut ok).unwrap();
        assert!(moved.is_none(), "{before:?}");
        assert_eq!(session.source_text(), before);
        assert_eq!(session.revision(), revision);
        assert!(!session.toolbar_state().can_undo, "{before:?}");
    }
    let mut session = EditorSession::open("a\nb\nc");
    session
        .replace(Revision(0), range(0, 0), "x", &mut ok)
        .unwrap();
    let to = slot(&session, 3);
    assert_eq!(
        session.move_block(Revision(0), DisplayOffset(0), to, &mut ok),
        Err(EditorError::StaleRevision {
            expected: Revision(0),
            actual: Revision(1)
        })
    );
    assert_eq!(
        session.block_slots(Revision(0), DisplayOffset(0), range(0, 1)),
        Err(EditorError::StaleRevision {
            expected: Revision(0),
            actual: Revision(1)
        })
    );
    assert_eq!(session.source_text(), "xa\nb\nc");
}
