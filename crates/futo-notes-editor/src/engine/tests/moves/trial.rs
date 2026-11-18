//! The slot trial against the real move: for every press and every
//! boundary of the fixture notes and of seeded notes, a boundary is offered
//! exactly when `move_block` there is accepted (#446). Front matter,
//! dividers, fences, tables, quotes, lists, empty tasks, photos, CRLF and
//! notes with and without a final line ending all appear, and the seeded
//! notes hold the lines a list arrival rewrites (#442): numbers with either
//! delimiter and leading zeros, nested and tab-indented items, checked
//! boxes, and texts a new marker or a lost indent would read as more.
use super::super::ok;
use super::corpus::fixture_notes;
use super::{line, slots};
use crate::engine::store;
use crate::lines::Kind;
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

/// The lines a press at line start `at` lifts when they must move byte
/// for byte: any block but an unquoted list item or plain line.
fn untouched(session: &EditorSession, at: DisplayOffset) -> Option<Vec<String>> {
    let engine = session.engine();
    let index = engine.line_at_display(store::display, at.0).0;
    let lines = engine.block_lines(index)?;
    let first = &engine.line(lines.start).line;
    let rewritten =
        first.quote == 0 && matches!(first.kind, Kind::List { .. } | Kind::Plain { .. });
    (!rewritten).then(|| lines.map(|i| engine.line(i).body().to_owned()).collect())
}

/// Whether `note` holds `lines` as consecutive lines.
fn holds(note: &str, lines: &[String]) -> bool {
    let all: Vec<&str> = note
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    all.windows(lines.len())
        .any(|run| run.iter().zip(lines).all(|(a, b)| a == b))
}

/// Offered equals accepted for every press on a line start or an image, and
/// a block that is no list item or plain line moves byte for byte.
fn check(note: &str) -> usize {
    let mut session = EditorSession::open(note);
    let display = session.display_text();
    let mut presses: Vec<_> = (0..session.engine().line_count())
        .map(|index| (line(&session, index), true))
        .chain(
            display
                .match_indices("![")
                .map(|(at, _)| (DisplayOffset(at), false)),
        )
        .collect();
    presses.sort_by_key(|(at, _)| at.0);
    presses.dedup_by_key(|(at, _)| *at);
    let mut tried = 0;
    for (at, line_start) in presses {
        let kept = line_start.then(|| untouched(&session, at)).flatten();
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
                if let Some(kept) = &kept {
                    let after = session.source_text();
                    assert!(
                        holds(&after, kept),
                        "{note:?}: {at:?} to {to:?} gave {after:?}"
                    );
                }
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
    "2. one",
    "  1. sub",
    "\t02) tab",
    "* [x] done",
    "  # not",
    "[ ] box",
    "  ```",
    "> q",
    ">   - qi",
    ">   first",
    "  ~~~",
    "    ---",
    "\t~~~",
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
