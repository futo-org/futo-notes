//! Truthful slots (#446): a slot is offered only where the move lands, a
//! renderer asks for the slots inside a display range, and two boundaries at
//! one display offset are two targets.
use super::super::properties::checks::check_fresh;
use super::super::{ok, range};
use super::corpus::fixture_notes;
use super::{line, slot, slots, NOTE};
use crate::{BlockBoundary, DisplayOffset, EditWork, EditorSession, LiftedBlock};
use std::ops::Range;

#[test]
fn a_drop_the_guard_would_cancel_is_no_slot() {
    // (note, the line lifted, the boundaries it may land on). `|---|` dropped
    // under `| a |` would make it a table header; the top of the note stays
    // a slot. Wherever `a` goes, the `---` it leaves reaches line 1 and opens
    // front matter with the later `---`: it lifts, and lands nowhere.
    for (note, from, want) in [
        ("| a |\n\n|---|", 2, &[0][..]),
        ("a\n---\nb\n---\nc", 0, &[]),
    ] {
        let mut session = EditorSession::open(note);
        let at = line(&session, from);
        assert!(session.block_at(session.revision(), at).unwrap().is_some());
        let want: Vec<_> = want.iter().map(|&b| slot(&session, b)).collect();
        assert_eq!(slots(&mut session, at), want, "{note:?}");
        assert_eq!(session.source_text(), note, "listing slots moves nothing");
        assert!(!session.toolbar_state().can_undo, "{note:?}");
    }
}

#[test]
fn the_corpus_is_each_fixtures_decoded_markdown() {
    let notes = fixture_notes();
    // fences.json marks this table's selection with `<` and `>`.
    assert!(notes.iter().any(|note| note == "| a |\n|---|\n| 1 |"));
    for mark in ['‸', '«', '»', '⟦', '⟧'] {
        assert!(
            !notes.iter().any(|note| note.contains(mark)),
            "{mark} left in"
        );
    }
}

#[test]
fn every_offered_slot_is_a_move_that_lands() {
    let mut moves = 0;
    for note in fixture_notes() {
        let mut session = EditorSession::open(&note);
        let display = session.display_text();
        // A press at each line's start, and on each image a finger can hold.
        let mut presses: Vec<_> = (0..session.engine().line_count())
            .map(|index| line(&session, index))
            .chain(display.match_indices("![").map(|(at, _)| DisplayOffset(at)))
            .collect();
        presses.dedup();
        for at in presses {
            let offered = slots(&mut session, at);
            assert!(
                offered.windows(2).all(|pair| pair[0] != pair[1]),
                "{note:?} at {at:?}: a slot twice in {offered:?}"
            );
            for to in offered {
                let revision = session.revision();
                session
                    .move_block(revision, at, to, &mut ok)
                    .unwrap()
                    .unwrap_or_else(|| {
                        panic!("{note:?}: {at:?} to {to:?} was offered, then refused")
                    });
                assert_ne!(session.source_text(), note, "{note:?}: {at:?} to {to:?}");
                check_fresh(session.engine(), &format!("{note:?} {at:?} to {to:?}"));
                session.undo(session.revision(), &mut ok).unwrap().unwrap();
                assert_eq!(session.source_text(), note, "undo {at:?} to {to:?}");
                moves += 1;
            }
        }
    }
    assert!(moves > 2000, "only {moves} offered moves were tried");
}

#[test]
fn the_boundaries_around_a_last_line_that_shows_nothing_are_two_slots() {
    // The task draws a box and no characters, so the display is `a\nb\n` and
    // the boundary above the task and the note's end are both at 4.
    let note = "a\nb\n- [ ] ";
    let mut session = EditorSession::open(note);
    assert_eq!(session.display_text(), "a\nb\n");
    let at = |at: usize, end: bool| BlockBoundary {
        at: DisplayOffset(at),
        end,
    };
    let (top, above_b, above_task, end) = (at(0, false), at(2, false), at(4, false), at(4, true));
    // The task lifts, from the top of its row to the note's end.
    assert_eq!(
        session
            .block_at(session.revision(), DisplayOffset(4))
            .unwrap(),
        Some(LiftedBlock {
            range: range(4, 4),
            to_end: true
        })
    );
    // (the press, its slots, a move to each and the note after).
    for (press, want, after) in [
        (0, [above_task, end], ["b\na\n- [ ] ", "b\n- [ ] \na"]),
        (2, [top, end], ["b\na\n- [ ] ", "a\n- [ ] \nb"]),
        (4, [top, above_b], ["- [ ] \na\nb", "a\n- [ ] \nb"]),
    ] {
        let press = DisplayOffset(press);
        assert_eq!(slots(&mut session, press), want, "{press:?}");
        for (to, after) in want.into_iter().zip(after) {
            let revision = session.revision();
            session
                .move_block(revision, press, to, &mut ok)
                .unwrap()
                .unwrap_or_else(|| panic!("{press:?} to {to:?} was refused"));
            assert_eq!(session.source_text(), after, "{press:?} to {to:?}");
            session.undo(session.revision(), &mut ok).unwrap().unwrap();
            assert_eq!(session.source_text(), note);
        }
    }
}

#[test]
fn a_renderer_asks_for_the_slots_inside_a_display_range() {
    // In NOTE the heading (line 3) lands on boundaries 5, 9, 10, 12, 15, 18,
    // 19 and 20; the plain line (4) also inside the list, on 6, 7 and 8.
    // A range from inside the list on reads the list from where it starts.
    // The hidden opening fence shares its display offset with the code line
    // after it, so a range starting at that line holds boundary 12.
    let session = EditorSession::open(NOTE);
    let revision = session.revision();
    let r = |session: &EditorSession, from: usize, to: usize| crate::DisplayRange {
        start: line(session, from),
        end: line(session, to),
    };
    let quoted = line(&session, 11).0 + 1;
    for (press, within, want) in [
        (3, r(&session, 6, 10), &[9, 10][..]),
        (4, r(&session, 6, 10), &[6, 7, 8, 9, 10]),
        (4, r(&session, 7, 7), &[7]),
        (3, r(&session, 13, 19), &[12, 15, 18, 19]),
        (
            3,
            range(quoted, line(&session, 20).0),
            &[12, 15, 18, 19, 20],
        ),
        (3, range(quoted, quoted), &[]),
    ] {
        let at = line(&session, press);
        let found = session.block_slots(revision, at, within).unwrap();
        let want: Vec<_> = want.iter().map(|&b| slot(&session, b)).collect();
        assert_eq!(found.slots, want, "line {press} within {within:?}");
    }
    // Read near the range: a fence opened under an item is that item's, so
    // the item after it joins the list; a blank line ends one; a line
    // outdented below a nested item is still the outer item's. (note, the
    // heading's line, its slots.)
    for (note, press, want) in [
        ("- a\n  ```\n  c\n  ```\n- b\n\n  x\n# h", 7, &[0, 5, 6][..]),
        ("- a\n    - b\n  c\nd\n# h", 4, &[0, 3]),
    ] {
        let mut session = EditorSession::open(note);
        let at = line(&session, press);
        let want: Vec<_> = want.iter().map(|&b| slot(&session, b)).collect();
        assert_eq!(slots(&mut session, at), want, "{note:?}");
    }
    // A range that is not on the display is refused, never clamped.
    let past = session.display_text().len() + 1;
    assert_eq!(
        session.block_slots(revision, line(&session, 3), range(0, past)),
        Err(crate::EditorError::InvalidRange)
    );
}

fn total(work: &EditWork) -> usize {
    work.materialized_source_bytes + work.parsed_source_bytes + work.link_metadata_items
}

/// A note of size `n`, the source line lifted and the source lines whose
/// boundaries are asked for (the screen).
type Shape = fn(usize) -> (String, usize, Range<usize>);

#[test]
fn the_work_to_find_the_slots_near_a_block_does_not_grow_with_the_note() {
    const MIXED: &str =
        "# h\npara\n- a\n  - b\n  note\n- c\n\n> q\n```\nx\n```\n| h |\n|---|\n| 1 |\n";
    const TAIL: &str = "# h\npara\n- a\n  - b\n- c\n\n> q\nend";
    // The last 31 lines of `note`, lifting the one `lifted` lines from the end.
    fn near_end(note: String, lifted: usize) -> (String, usize, Range<usize>) {
        let count = note.split('\n').count();
        (note, count - 1 - lifted, count - 31 - lifted..count)
    }
    let shapes: [(&str, Shape); 16] = [
        // The note above grows.
        ("a heading under mixed blocks", |n| {
            near_end(MIXED.repeat(n) + TAIL, 7)
        }),
        ("a paragraph under mixed blocks", |n| {
            near_end(MIXED.repeat(n) + TAIL, 6)
        }),
        ("an item under mixed blocks", |n| {
            near_end(MIXED.repeat(n) + TAIL, 5)
        }),
        ("a quote under mixed blocks", |n| {
            near_end(MIXED.repeat(n) + TAIL, 1)
        }),
        ("a heading under one item holding every line", |n| {
            let note = format!(
                "- top\n{}# h\npara\n# k\nend",
                "  - [ ] t\n    note\n".repeat(n)
            );
            near_end(note, 3)
        }),
        ("a heading under a long code block", |n| {
            near_end(
                format!("```\n{}```\npara\n# h\nnext\nend", "x\ny\n".repeat(n)),
                2,
            )
        }),
        ("an item in a checklist", |n| {
            near_end("- [ ] a\n- [x] b\n".repeat(n) + "end", 1)
        }),
        ("a heading under one item's paragraphs", |n| {
            near_end(
                format!("- parent\n{}# heading\nend", "  paragraph\n".repeat(n)),
                1,
            )
        }),
        // Every trial moves a `---`, in a note with front matter.
        ("a divider under front matter", |n| {
            let note = format!(
                "---\ntags: a\n---\n{}alpha\n---\nbravo\ncharlie\nend",
                "body\n".repeat(n)
            );
            near_end(note, 3)
        }),
        // The note below grows.
        ("a line under an unclosed `---` on line 1", |n| {
            (format!("---\nalpha\nbeta\n{}", "t\n".repeat(n)), 1, 0..6)
        }),
        ("a heading above mixed blocks", |n| {
            (TAIL.to_owned() + "\n" + &MIXED.repeat(n), 0, 0..31)
        }),
        // The lifted block grows.
        ("a long quote", |n| {
            let note = format!("{}{}after", "p\n".repeat(20), "> q\n".repeat(n));
            (note, 20, 0..21)
        }),
        ("a long code block", |n| {
            let note = format!("{}```\n{}```\nafter", "p\n".repeat(20), "x\n".repeat(n));
            (note, 20, 0..21)
        }),
        // An item whose lines shift as it lands in a nested list.
        ("an item with many lines under it", |n| {
            let note = format!(
                "{}- big\n{}after",
                "- p\n    - q\n".repeat(10),
                "  - c\n".repeat(n)
            );
            (note, 20, 0..21)
        }),
        // The first of many items that read alike, the range at the end:
        // every candidate but the last moves it past copies of itself.
        (
            "an item far above the range among items that read alike",
            |n| {
                // One width of number, so lines read the same at both sizes.
                let items: String = (1..=n).map(|i| format!("{i:05}. x\n")).collect();
                let note = format!("{items}y\nz");
                let count = n + 2;
                (note, 0, count - 31..count)
            },
        ),
        // A line landing in a numbered list that runs on below the range.
        ("a line into a long numbered list", |n| {
            let items: String = (1..=n).map(|i| format!("{i}. item\n")).collect();
            (format!("x\n{items}end"), 0, 0..31)
        }),
    ];
    for (name, shape) in shapes {
        let work = |n: usize| {
            let (note, lifted, lines) = shape(n);
            let session = EditorSession::open(&note);
            let within = crate::DisplayRange {
                start: line(&session, lines.start),
                end: line(&session, lines.end),
            };
            let at = line(&session, lifted);
            let found = session.block_slots(session.revision(), at, within).unwrap();
            assert!(!found.slots.is_empty(), "{name}");
            found.work
        };
        let (short, long) = (work(500), work(10_000));
        assert!(total(&short) > 0, "{name}");
        assert_eq!(short, long, "{name}");
    }
}

/// With front matter, every candidate asks whether the lines it shifts make
/// or break a `---` there. The lifted lines are read once for the whole
/// query, not once per candidate: the work grows by a visit per lifted line
/// at most, where one visit per candidate made it ten times that.
#[test]
fn front_matter_reads_the_shifted_lines_once_per_query() {
    let work = |n: usize| {
        let note = format!(
            "---\ntags: a\n---\n{}- big\n{}after",
            "- p\n    - q\n".repeat(10),
            "  - c\n".repeat(n)
        );
        let session = EditorSession::open(&note);
        let within = crate::DisplayRange {
            start: line(&session, 3),
            end: line(&session, 24),
        };
        let at = line(&session, 23);
        let found = session.block_slots(session.revision(), at, within).unwrap();
        assert!(found.slots.len() > 10, "{} slots", found.slots.len());
        total(&found.work)
    };
    let (short, long) = (work(500), work(10_000));
    assert!(
        long - short <= 10_000 - 500,
        "{short} at 500 lines, {long} at 10,000"
    );
}
