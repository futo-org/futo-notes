//! Truthful slots (#446): a slot is offered only where the move lands, a
//! renderer asks for the slots inside a display range, and two boundaries at
//! one display offset are two targets.
use super::super::properties::checks::check_fresh;
use super::super::{ok, range};
use super::{line, slot, slots, NOTE};
use crate::{BlockBoundary, DisplayOffset, EditWork, EditorSession, LiftedBlock};

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

/// Every note the engine and Linedown fixtures hold (every JSON file under
/// `tests/fixtures/`), as written and without its first `|` (most engine
/// fixtures mark the caret with one).
fn fixture_notes() -> Vec<String> {
    fn files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                out.push(path);
            }
        }
    }
    fn walk(value: &serde_json::Value, notes: &mut Vec<String>) {
        match value {
            serde_json::Value::Array(items) => items.iter().for_each(|item| walk(item, notes)),
            serde_json::Value::Object(fields) => {
                for (key, field) in fields {
                    match field.as_str() {
                        Some(note) if matches!(key.as_str(), "input" | "before" | "after") => {
                            notes.push(note.to_owned());
                            notes.push(note.replacen('|', "", 1));
                        }
                        _ => walk(field, notes),
                    }
                }
            }
            _ => {}
        }
    }
    let mut paths = Vec::new();
    files(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures"),
        &mut paths,
    );
    assert!(paths.len() > 20, "fixtures not found: {paths:?}");
    let mut notes = vec![NOTE.to_owned(), "a\nb\n- [ ] ".to_owned()];
    for path in paths {
        let file = std::fs::read_to_string(&path).unwrap();
        walk(&serde_json::from_str(&file).unwrap(), &mut notes);
    }
    notes.sort();
    notes.dedup();
    notes
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
    let mut session = EditorSession::open(NOTE);
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

#[test]
fn the_work_to_find_the_slots_near_a_block_does_not_grow_with_the_note() {
    // `head`, `copies` copies of `body`, then `tail`; the line `lifted` lines
    // from the note's end lifted and the slots asked for the 30 lines above
    // it and the lines below: what a lift asks for the screen.
    fn work(head: &str, body: &str, tail: &str, lifted: usize, copies: usize) -> EditWork {
        let note = format!("{head}{}{tail}", body.repeat(copies));
        let mut session = EditorSession::open(&note);
        let count = session.engine().line_count();
        let at = line(&session, count - 1 - lifted);
        let within = crate::DisplayRange {
            start: line(&session, count - 31 - lifted),
            end: line(&session, count),
        };
        let found = session.block_slots(session.revision(), at, within).unwrap();
        assert!(found.slots.len() > 2, "{tail:?}: {:?}", found.slots);
        found.work
    }
    let mixed = "# h\npara\n- a\n  - b\n  note\n- c\n\n> q\n```\nx\n```\n| h |\n|---|\n| 1 |\n";
    // (head, body, tail, the lifted line counted from the end): mixed blocks
    // with a heading, a paragraph, an item or a quote lifted; one item
    // holding every line above a heading; a code block above a paragraph
    // and a heading; a checklist.
    let tail = "# h\npara\n- a\n  - b\n- c\n\n> q\nend";
    for (head, body, tail, lifted) in [
        ("", mixed, tail, 7),
        ("", mixed, tail, 6),
        ("", mixed, tail, 5),
        ("", mixed, tail, 1),
        ("- top\n", "  - [ ] t\n    note\n", "# h\npara\n# k\nend", 3),
        ("```\n", "x\ny\n", "```\npara\n# h\nnext\nend", 3),
        ("```\n", "x\ny\n", "```\npara\n# h\nnext\nend", 2),
        ("", "- [ ] a\n- [x] b\n", "end", 1),
    ] {
        let short = work(head, body, tail, lifted, 500);
        let long = work(head, body, tail, lifted, 10_000);
        assert!(total(&short) > 0, "{body:?}");
        assert_eq!(
            short, long,
            "{body:?} then {tail:?}, line {lifted} from the end"
        );
    }
}
