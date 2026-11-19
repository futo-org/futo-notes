//! Moving list items whose markers show as units: each item's marker (a
//! task's box included) is one U+FFFC of 3 bytes at the item's display
//! start, so every display offset below counts it. What lifts, where it may
//! land and where the selection goes, in display and source offsets.
use super::super::{ok, range};
use super::slots;
use crate::{BlockBoundary, DisplayOffset, EditorSession, LiftedBlock};

fn boundary(at: usize, end: bool) -> BlockBoundary {
    BlockBoundary {
        at: DisplayOffset(at),
        end,
    }
}

/// The source range of the session's selection.
fn source(session: &EditorSession) -> std::ops::Range<usize> {
    session.engine().source_selection(session.selection())
}

#[test]
fn an_item_lifts_from_before_its_marker_with_the_items_under_it() {
    // `\u{fffc}a\n\u{fffc}b\n\u{fffc}c\n\u{fffc}d`: the items start at 0,
    // 5, 10 and 15; `c` is nested under `b`.
    let session = EditorSession::open("- a\n- b\n  - c\n- d");
    assert_eq!(
        session.display_text(),
        "\u{fffc}a\n\u{fffc}b\n\u{fffc}c\n\u{fffc}d"
    );
    let revision = session.revision();
    let b_and_c = Some(LiftedBlock {
        range: range(5, 15),
        to_end: false,
    });
    // Before the marker unit, after it, and on the text.
    for at in [5, 8, 9] {
        assert_eq!(
            session.block_at(revision, DisplayOffset(at)).unwrap(),
            b_and_c,
            "{at}"
        );
    }
    // Inside the unit is no display position.
    assert!(session.block_at(revision, DisplayOffset(6)).is_err());
    assert_eq!(
        session.block_at(revision, DisplayOffset(15)).unwrap(),
        Some(LiftedBlock {
            range: range(15, 19),
            to_end: true
        })
    );
}

#[test]
fn an_items_slots_are_named_at_line_starts_before_the_marker_units() {
    let mut session = EditorSession::open("- a\n- b\n  - c\n- d");
    // `- d` lands above `a`, above `b` and between `b` and `c` (as `c`'s
    // sibling); its own edges are no slots.
    assert_eq!(
        slots(&mut session, DisplayOffset(15)),
        [boundary(0, false), boundary(5, false), boundary(10, false)]
    );
    let revision = session.revision();
    session
        .move_block(revision, DisplayOffset(15), boundary(10, false), &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), "- a\n- b\n  - d\n  - c");
}

#[test]
fn a_selected_item_with_its_marker_travels_whole() {
    // (note, the selection, the line pressed, the boundary's display offset,
    // the note after, the display selection after, its source after).
    type Case = (
        &'static str,
        (usize, usize),
        usize,
        (usize, bool),
        &'static str,
        (usize, usize),
        (usize, usize),
    );
    let cases: [Case; 5] = [
        // A caret before a marker the move keeps stays before it.
        (
            "- a\n- b\n- c",
            (10, 10),
            10,
            (0, false),
            "- c\n- a\n- b",
            (0, 0),
            (0, 0),
        ),
        // A bullet item, its marker unit and text selected, to the top.
        (
            "- a\n- b\n- c",
            (10, 14),
            10,
            (0, false),
            "- c\n- a\n- b",
            (0, 4),
            (0, 3),
        ),
        // A task, its box unit and text, to the note's end.
        (
            "- [ ] a\n- [x] b\n- [ ] c",
            (0, 4),
            0,
            (14, true),
            "- [x] b\n- [ ] c\n- [ ] a",
            (10, 14),
            (16, 23),
        ),
        // A nested item with its child, the child's text selected: the
        // pair goes to the left margin below the list.
        (
            "- a\n  - b\n    - c\n- d",
            (13, 14),
            5,
            (19, true),
            "- a\n- d\n- b\n  - c",
            (18, 19),
            (16, 17),
        ),
        // A quoted list lifts as its quote run; a caret after `b` moves
        // with it.
        (
            "> - a\n> - b\n\nx",
            (9, 9),
            5,
            (12, true),
            "\nx\n> - a\n> - b",
            (12, 12),
            (14, 14),
        ),
    ];
    for (before, selected, pressed, to, after, landed, landed_source) in cases {
        let mut session = EditorSession::open(before);
        let revision = session.revision();
        session
            .select(revision, range(selected.0, selected.1))
            .unwrap();
        let selected_source = source(&session);
        session
            .move_block(
                revision,
                DisplayOffset(pressed),
                boundary(to.0, to.1),
                &mut ok,
            )
            .unwrap()
            .unwrap_or_else(|| panic!("{before:?} to {to:?} was refused"));
        assert_eq!(session.source_text(), after, "{before:?}");
        assert_eq!(session.selection(), range(landed.0, landed.1), "{before:?}");
        assert_eq!(
            source(&session),
            landed_source.0..landed_source.1,
            "{before:?}"
        );
        session.undo(session.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(session.source_text(), before, "undo {before:?}");
        assert_eq!(session.selection(), range(selected.0, selected.1));
        assert_eq!(source(&session), selected_source, "undo {before:?}");
    }
}

#[test]
fn a_renumbered_item_keeps_its_text_selected_and_its_caret() {
    // `\u{fffc}a\n\u{fffc}b\n\u{fffc}c`: `c` is at 13. Moved between `a`
    // and `b` it counts as 2 and `b` counts on: `c` is at 8, source 8.
    let mut session = EditorSession::open("1. a\n2. b\n3. c");
    let revision = session.revision();
    session.select(revision, range(13, 14)).unwrap();
    session
        .move_block(revision, DisplayOffset(10), boundary(5, false), &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), "1. a\n2. c\n3. b");
    assert_eq!(session.selection(), range(8, 9));
    assert_eq!(source(&session), 8..9);
}
