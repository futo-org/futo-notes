//! The slot trial against the real move: for every press and every
//! boundary of the fixture notes and of seeded notes, a boundary is offered
//! exactly when `move_block` there is accepted (#446). Front matter,
//! dividers, fences, tables, quotes, lists, empty tasks, photos, CRLF and
//! notes with and without a final line ending all appear.
use super::super::ok;
use super::corpus::fixture_notes;
use super::{line, slots};
use crate::{BlockBoundary, DisplayOffset, EditorSession};

/// Every boundary of `session`'s note as a renderer names it.
fn names(session: &EditorSession) -> Vec<BlockBoundary> {
    let count = session.engine().line_count();
    let mut names: Vec<_> = (0..=count)
        .map(|index| BlockBoundary {
            at: line(session, index),
            end: index == count,
        })
        .collect();
    names.dedup();
    names
}

/// Offered equals accepted for every press on a line start or an image.
fn check(note: &str) -> usize {
    let mut session = EditorSession::open(note);
    let display = session.display_text();
    let mut presses: Vec<_> = (0..session.engine().line_count())
        .map(|index| line(&session, index))
        .chain(display.match_indices("![").map(|(at, _)| DisplayOffset(at)))
        .collect();
    presses.sort_by_key(|at| at.0);
    presses.dedup();
    let mut tried = 0;
    for at in presses {
        let offered = slots(&mut session, at);
        for to in names(&session) {
            let revision = session.revision();
            let moved = session.move_block(revision, at, to, &mut ok).unwrap();
            assert_eq!(
                moved.is_some(),
                offered.contains(&to),
                "{note:?}: a press at {at:?} to {to:?}"
            );
            if moved.is_some() {
                session.undo(session.revision(), &mut ok).unwrap().unwrap();
                assert_eq!(session.source_text(), note);
            }
            tried += 1;
        }
    }
    tried
}

#[test]
fn a_slot_is_offered_exactly_where_the_move_is_accepted_in_every_fixture() {
    let tried: usize = fixture_notes().iter().map(|note| check(note)).sum();
    assert!(tried > 5000, "only {tried} moves tried");
}

/// Lines a seeded note is made of: every kind a move can change.
const LINES: &[&str] = &[
    "---",
    "tags: a",
    "plain",
    "# head",
    "- item",
    "  - nested",
    "    deeper",
    "  under",
    "- [ ] task",
    "- [ ] ",
    "- ",
    "1. one",
    "> q",
    "> - r",
    ">",
    "```",
    "code",
    "| h |",
    "|---|",
    "| 1 |",
    "",
    "  ",
    "Nice!![](a.jpg)",
    "![](b.jpg)",
    "x ![](c.jpg) y",
    "***",
];

#[test]
fn a_slot_is_offered_exactly_where_the_move_is_accepted_in_seeded_notes() {
    let mut seed: u64 = 0x446_5eed;
    let mut next = |below: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % below as u64) as usize
    };
    let mut tried = 0;
    for _ in 0..1500 {
        // Mostly short notes; some long enough for runs the trial reads
        // past without reading every line.
        let longest = if next(4) == 0 { 30 } else { 9 };
        let count = 1 + next(longest);
        let ending = if next(5) == 0 { "\r\n" } else { "\n" };
        let mut note: Vec<&str> = (0..count).map(|_| LINES[next(LINES.len())]).collect();
        if next(3) == 0 {
            note.splice(0..0, ["---", "tags: a", "---"]);
        }
        let mut note = note.join(ending);
        if next(3) == 0 {
            note.push_str(ending);
        }
        tried += check(&note);
    }
    assert!(tried > 60_000, "only {tried} moves tried");
}
