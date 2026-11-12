//! Find on the core: the literal cases in `tests/fixtures/engine/find.json`,
//! stepping, scans and how matches follow edits.
use super::{ok, range, typed};
use crate::engine::Engine;
use crate::{CaretDirection, DisplayRange, FindScanResult, InputAction, Revision};
use serde_json::Value;

/// The display text of every match, in order.
fn found(engine: &mut Engine) -> Vec<String> {
    let display = engine.display_text();
    engine
        .find_matches(engine.revision(), range(0, display.len()))
        .unwrap()
        .iter()
        .map(|found| display[found.start.0..found.end.0].to_owned())
        .collect()
}

fn all(engine: &mut Engine) -> Vec<DisplayRange> {
    let end = engine.display_len();
    engine
        .find_matches(engine.revision(), range(0, end))
        .unwrap()
}

fn rescan(engine: &mut Engine) -> crate::FindReport {
    let request = engine.find_scan_request().unwrap();
    engine.find_apply_scan(&request.run()).unwrap()
}

#[test]
fn the_find_table() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../tests/fixtures/engine/find.json")).unwrap();
    assert_eq!(cases.len(), 45);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let before = case["before"].as_str().unwrap();
        let query = case["command"]["find"].as_str().unwrap();
        let after = &case["after"];
        let mut engine = Engine::open(before);
        if let Some(at) = case["at"].as_u64() {
            let at = at as usize;
            engine.select(Revision(0), range(at, at)).unwrap();
        }
        let report = engine.find_set_query(Revision(0), query).unwrap();
        let expected: Vec<&str> = after["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|text| text.as_str().unwrap())
            .collect();
        assert_eq!(found(&mut engine), expected, "{name}");
        assert_eq!(report.total, expected.len(), "{name}");
        assert!(!report.stale, "{name}");
        if let Some(current) = after["current"].as_u64() {
            assert_eq!(report.current, current as usize, "{name}");
            assert_eq!(report.reveal, report.current_range, "{name}");
        }
        if let Some(source) = after["source"].as_str() {
            let tight = report.current_source.unwrap();
            assert_eq!(
                engine.source_slice(tight.start.0..tight.end.0),
                source,
                "{name}"
            );
        }
        // Every match is selectable and maps to source and back exactly.
        for _ in 0..report.total {
            let step = engine
                .find_step(Revision(0), CaretDirection::Forward)
                .unwrap();
            let shown = step.current_range.unwrap();
            assert_eq!(step.reveal, Some(shown), "{name}");
            assert_eq!(engine.selection(), shown, "{name}: the match is selected");
            let tight = step.current_source.unwrap();
            assert_eq!(engine.display_of(tight.start.0), shown.start.0, "{name}");
            assert_eq!(engine.display_of(tight.end.0), shown.end.0, "{name}");
        }
        // Find never edits the note or its history.
        assert_eq!(engine.source_text(), before, "{name}");
        assert_eq!(engine.revision(), Revision(0), "{name}");
        assert!(!engine.can_undo(), "{name}");
    }
}

#[test]
fn stepping_wraps_selects_and_closing_keeps_the_query() {
    let mut engine = Engine::open("x one\nX two\n\nx **th**ree");
    let report = engine.find_set_query(Revision(0), "x").unwrap();
    assert_eq!((report.total, report.current), (3, 1));
    assert_eq!(report.reveal, Some(range(0, 1)));
    let mut visit = |direction| {
        let report = engine.find_step(Revision(0), direction).unwrap();
        assert_eq!(engine.selection(), report.reveal.unwrap());
        report.current
    };
    let forward: Vec<_> = (0..4).map(|_| visit(CaretDirection::Forward)).collect();
    assert_eq!(forward, [2, 3, 1, 2]);
    let backward: Vec<_> = (0..3).map(|_| visit(CaretDirection::Backward)).collect();
    assert_eq!(backward, [1, 3, 2]);

    let closed = engine.find_close();
    assert_eq!((closed.open, closed.total, closed.current), (false, 0, 0));
    assert_eq!(closed.query, "x");
    let selection = engine.selection();
    let step = engine
        .find_step(Revision(0), CaretDirection::Forward)
        .unwrap();
    assert_eq!((step.total, step.reveal), (0, None));
    assert_eq!(engine.selection(), selection);
    assert!(engine.find_scan_request().is_none());

    let none = engine.find_set_query(Revision(0), "zzz").unwrap();
    assert_eq!((none.total, none.current, none.reveal), (0, 0, None));
    let step = engine
        .find_step(Revision(0), CaretDirection::Backward)
        .unwrap();
    assert_eq!(step.current, 0);
    assert_eq!(engine.revision(), Revision(0));
    assert!(engine.undo(Revision(0), &mut ok).unwrap().is_none());
}

#[test]
fn stepping_waits_out_composition() {
    let mut engine = Engine::open("cat cat");
    let before = engine.find_set_query(Revision(0), "cat").unwrap();
    engine.compose(Revision(0), range(0, 0), "x").unwrap();
    let step = engine
        .find_step(Revision(0), CaretDirection::Forward)
        .unwrap();
    assert_eq!((step.current, step.reveal), (before.current, None));
    assert_eq!(engine.selection(), range(0, 0));
}

#[test]
fn input_carries_matches_without_scanning_and_refuses_stale_scans() {
    let source = "cat one\n\ncat two\nbird cat three\n- cat four";
    let mut engine = Engine::open(source);
    engine.find_set_query(Revision(0), "cat").unwrap();
    let request = engine.find_scan_request().unwrap();
    let before = engine.find_work();
    assert_eq!(before.scans, 1);

    engine.select(Revision(0), range(4, 4)).unwrap();
    typed(&mut engine, "ZZZ");
    let report = engine.find_report();
    assert!(report.stale);
    assert_eq!(engine.find_work(), before, "typing costs no scan");
    let display = engine.display_text();
    let mapped = all(&mut engine);
    assert_eq!(mapped.len(), 4);
    for found in &mapped {
        assert_eq!(&display[found.start.0..found.end.0], "cat");
    }

    // A scan taken before the edit is refused; a fresh one lands.
    assert!(engine.find_apply_scan(&request.run()).is_none());
    let report = rescan(&mut engine);
    assert_eq!((report.total, report.stale), (4, false));
    assert_eq!(engine.find_work().scans, 2);

    // Closing and reopening refuses a scan for the old query.
    let pending = engine.find_scan_request().unwrap();
    engine.find_close();
    engine.find_set_query(Revision(1), "cat").unwrap();
    assert!(engine.find_apply_scan(&pending.run()).is_none());

    // Another engine's scan is not ours, even at the same revision and query.
    let mut other = Engine::open(source);
    other.find_set_query(Revision(0), "cat").unwrap();
    let mut mine = Engine::open(source);
    mine.find_set_query(Revision(0), "cat").unwrap();
    assert!(mine
        .find_apply_scan(&other.find_scan_request().unwrap().run())
        .is_none());
    // Host matches out of order, overlapping, empty, out of range or inside
    // a character are refused.
    let ours = mine.find_scan_request().unwrap().run();
    for matches in [
        vec![range(9, 12), range(0, 3)],
        vec![range(0, 3), range(2, 5)],
        vec![range(3, 3)],
        vec![range(0, source.len() + 1)],
    ] {
        let forged = FindScanResult {
            matches,
            ..ours.clone()
        };
        assert!(mine.find_apply_scan(&forged).is_none(), "{forged:?}");
    }
    let mut wide = Engine::open("é cat");
    wide.find_set_query(Revision(0), "cat").unwrap();
    let forged = FindScanResult {
        matches: vec![range(1, 6)],
        ..wide.find_scan_request().unwrap().run()
    };
    assert!(wide.find_apply_scan(&forged).is_none());
    assert!(mine.find_apply_scan(&ours).is_some());
}

#[test]
fn an_edit_inside_a_match_drops_it_and_others_shift() {
    let mut engine = Engine::open("cat\n**cat** x\ncat");
    engine.find_set_query(Revision(0), "cat").unwrap();
    assert_eq!(all(&mut engine), [range(0, 3), range(4, 7), range(10, 13)]);
    // An edit beside a match on its line leaves it; later ones shift.
    engine.select(Revision(0), range(8, 9)).unwrap();
    typed(&mut engine, "yy");
    assert_eq!(all(&mut engine), [range(0, 3), range(4, 7), range(11, 14)]);
    let rev = engine.revision();
    engine
        .replace(rev, range(5, 6), "u", InputAction::Typing, &mut ok)
        .unwrap();
    let report = engine.find_report();
    assert_eq!((report.total, report.current), (2, 1));
    assert_eq!(all(&mut engine), [range(0, 3), range(11, 14)]);
    // Undo restores the bytes; a rescan finds the match again.
    let rev = engine.revision();
    engine.undo(rev, &mut ok).unwrap().unwrap();
    assert_eq!(rescan(&mut engine).total, 3);
}

#[test]
fn a_change_the_log_did_not_see_drops_the_matches() {
    let mut engine = Engine::open("cat cat");
    engine.find_set_query(Revision(0), "cat").unwrap();
    // As if a path changed the note without logging it.
    engine.revision = Revision(1);
    let report = engine.find_report();
    assert_eq!((report.total, report.current, report.stale), (0, 0, true));
    assert_eq!(report.dropped, 1);
    assert_eq!(rescan(&mut engine).total, 2);
}

/// A small random generator, so the run is the same every time.
struct Random(u64);

impl Random {
    fn below(&mut self, bound: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % bound as u64) as usize
    }
}

/// The character boundary at or before display offset `at`.
fn boundary(engine: &Engine, mut at: usize) -> usize {
    let display = engine.display_text();
    while !display.is_char_boundary(at) {
        at -= 1;
    }
    at
}

#[test]
fn matches_follow_random_edits_and_a_rescan_equals_a_fresh_find() {
    const PIECES: &[&str] = &[
        "cat", "c", "a", "t", "C", " ", "\n", "**", "*", "`", "| ", "|---|\n", "- ", "# ", "> ",
        "```\n", "[", "](u)", "\\",
    ];
    let mut random = Random(0x5eed_f1d0_cafe_0001);
    for case in 0..300 {
        let mut text = String::new();
        for _ in 0..random.below(12) {
            text.push_str(PIECES[random.below(PIECES.len())]);
        }
        let mut engine = Engine::open(&text);
        engine.find_set_query(Revision(0), "cat").unwrap();
        for _ in 0..12 {
            let rev = engine.revision();
            match random.below(6) {
                0 if engine.can_undo() => {
                    engine.undo(rev, &mut ok).unwrap();
                }
                1 => {
                    let at = boundary(&engine, random.below(engine.display_len() + 1));
                    let to = engine.grapheme_stop(at, CaretDirection::Forward);
                    let _ = engine.replace(rev, range(at, to), "", InputAction::Typing, &mut ok);
                }
                _ => {
                    let at = boundary(&engine, random.below(engine.display_len() + 1));
                    let piece = PIECES[random.below(PIECES.len())];
                    let _ = engine.replace(rev, range(at, at), piece, InputAction::Typing, &mut ok);
                }
            }
            let context = format!("case {case} {text:?} now {:?}", engine.source_text());
            // Carried matches still show the query, in order, never overlapping.
            let display = engine.display_text();
            let mut previous = 0;
            for found in all(&mut engine) {
                assert!(found.start.0 >= previous, "{context}");
                assert!(
                    display[found.start.0..found.end.0].eq_ignore_ascii_case("cat"),
                    "{context}: {found:?} in {display:?}"
                );
                previous = found.end.0;
            }
            let report = engine.find_report();
            if let Some(current) = report.current_range {
                assert!(
                    display[current.start.0..current.end.0].eq_ignore_ascii_case("cat"),
                    "{context}"
                );
            }
        }
        // A rescan equals a fresh find on the same text.
        rescan(&mut engine);
        let mut fresh = Engine::open(&engine.source_text());
        fresh.find_set_query(Revision(0), "cat").unwrap();
        assert_eq!(all(&mut engine), all(&mut fresh), "case {case}");
    }
}

#[test]
fn a_20000_line_note_types_without_scanning_and_scans_tables_only() {
    let mut source = String::new();
    for line in 0..20_000 {
        source.push_str(match line % 5 {
            0 => "- a cat item **bold**\n",
            1 => "plain cat text\n",
            2 => "```\n",
            3 => "a | b | cat\n",
            _ => "```\n",
        });
    }
    let table = "| h | i |\n|---|---|\n| cat | x |\n";
    source.push_str(table);
    let mut engine = Engine::open(&source);
    let report = engine.find_set_query(Revision(0), "cat").unwrap();
    assert_eq!(report.total, 12_001);
    let work = engine.find_work();
    assert_eq!(work.scans, 1);
    // The old engine read 56,040 bytes for its barriers on a smaller note
    // (the old `table_barriers_scan_each_run_once_not_once_per_pipe_line`);
    // the core reads only the table's lines.
    assert_eq!(work.barrier_bytes, table.len() as u64);

    // Typing with find open logs a window and never scans; reading the
    // report carries the matches.
    let end = engine.display_len();
    engine.select(Revision(0), range(end, end)).unwrap();
    for _ in 0..200 {
        typed(&mut engine, "z");
        let report = engine.find_report();
        assert!(report.stale);
        assert_eq!(report.total, 12_001);
    }
    assert_eq!(engine.find_work(), work);
    // Past the log's limit with no read between, the matches wait for a scan.
    for _ in 0..65 {
        typed(&mut engine, "z");
    }
    assert_eq!(engine.find_report().total, 0);
    assert_eq!(rescan(&mut engine).total, 12_001);
}
