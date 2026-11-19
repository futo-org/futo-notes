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
use std::ops::Range;

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

#[test]
fn a_shifted_fence_line_that_becomes_or_stops_being_a_dash_line_is_read_as_written() {
    // Outdented, `  ---` in the code becomes a second `---` and the divider
    // on line 1 would open front matter; indented, the second `---` stops
    // being one and line 1 stays a divider.
    for note in [
        "---\n\n  - a\n    ~~~\n  ---\n    ~~~\n\ntail",
        "- a\n  ~~~\n---\n  ~~~\n---\n- p\n  - target\nend",
    ] {
        check(note);
    }
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

/// A numbered line's digits, and the line without them.
fn digits(line: &str) -> (&str, String) {
    let lead = line.len() - line.trim_start_matches([' ', '\t']).len();
    let end = lead + line[lead..].bytes().take_while(u8::is_ascii_digit).count();
    (
        &line[lead..end],
        format!("{}{}", &line[..lead], &line[end..]),
    )
}

/// Whether moving lines `block` of `before` to boundary `slot`, giving
/// `after`, changed nothing but the numbers it rewrote: each line reads as
/// the one that was in its place, but for digits that differ from the
/// digits it came with. (A line that keeps its own number where another
/// number was is a change, as `1. a\n5. a` trading places is.)
fn numbers_only(before: &str, after: &str, block: &Range<usize>, slot: usize) -> bool {
    let (was, now): (Vec<_>, Vec<_>) = (before.split('\n').collect(), after.split('\n').collect());
    let (s, e) = (block.start, block.end);
    let came_from = |p: usize| match p {
        p if p < s.min(slot) || p >= e.max(slot) => p,
        p if slot < s && p < slot + (e - s) => s + p - slot,
        p if slot < s => p - (e - s),
        p if p < slot - (e - s) => p + (e - s),
        p => s + p - (slot - (e - s)),
    };
    was.len() == now.len()
        && was.iter().zip(&now).enumerate().all(|(p, (w, n))| {
            let ((_, w_rest), (n_digits, n_rest)) = (digits(w), digits(n));
            w == n || (w_rest == n_rest && n_digits != digits(was[came_from(p)]).0)
        })
}

/// Lines a short numbered-list note is made of: numbers counting, alike
/// and out of sequence, both delimiters, leading zeros, nesting, a bullet,
/// a plain line and a blank one, over few texts so moves can trade alike
/// lines.
const NUMBERED: &[&str] = &[
    "1. a", "2. a", "2. b", "3. a", "5. b", "1) a", "2) a", "  1. a", "  2. b", "01. a", "02. a",
    "- a", "a", "",
];

#[test]
fn in_short_numbered_lists_every_offered_slot_is_accepted_and_changes_more_than_numbers() {
    let mut seed: u64 = 0x442_1234;
    let mut next = |below: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % below as u64) as usize
    };
    let mut tried = 0;
    for _ in 0..3000 {
        let count = 1 + next(5);
        let note: Vec<&str> = (0..count).map(|_| NUMBERED[next(NUMBERED.len())]).collect();
        let note = note.join("\n");
        let mut session = EditorSession::open(&note);
        assert_eq!(session.engine().line_count(), count, "{note:?}");
        for index in 0..count {
            let Some(block) = session.engine().block_lines(index) else {
                continue;
            };
            let at = line(&session, index);
            let offered = slots(&mut session, at);
            for slot in 0..=count {
                let to = super::slot(&session, slot);
                let revision = session.revision();
                let moved = session.move_block(revision, at, to, &mut ok).unwrap();
                assert_eq!(
                    moved.is_some(),
                    offered.contains(&to),
                    "{note:?}: {index} to {slot}"
                );
                if moved.is_some() {
                    let after = session.source_text();
                    assert!(
                        !numbers_only(&note, &after, &block, slot),
                        "{note:?}: {index} to {slot} changed only numbers: {after:?}"
                    );
                    session.undo(session.revision(), &mut ok).unwrap().unwrap();
                    assert_eq!(session.source_text(), note);
                }
                tried += 1;
            }
        }
    }
    assert!(tried > 30_000, "only {tried} moves tried");
}
