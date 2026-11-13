use futo_notes_editor::{
    CaretDirection, DisplayOffset, DisplayRange, EditorSession, FindScanResult, Revision,
};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

/// Display text of every match, in order, for a fresh find on `source`.
fn found(source: &str, query: &str) -> Vec<String> {
    let mut session = EditorSession::open(source);
    let report = session.find_set_query(Revision(0), query).unwrap();
    let display = session.display_text();
    let all = session
        .find_matches(Revision(0), range(0, display.len()))
        .unwrap();
    assert_eq!(report.total, all.len());
    all.iter()
        .map(|found| display[found.start.0..found.end.0].to_owned())
        .collect()
}

#[test]
fn matching_reads_visible_text_across_marks_but_not_line_breaks() {
    let cases: &[(&str, &str, &[&str])] = &[
        // Case-insensitive literal, no word or prefix rules.
        ("Concatenate CAT cat", "cat", &["cat", "CAT", "cat"]),
        ("Aug 3 and August", "Aug ", &["Aug "]),
        // Hidden markers are not findable; visible text spans them.
        ("a **bo**ld *x*", "bold", &["bold"]),
        ("a **bo**ld", "**", &[]),
        ("see [t](http://u) `co` [[Wiki|alias]]", "co", &["co"]),
        ("see [t](http://u) [[Wiki|alias]]", "alias", &["alias"]),
        ("see [t](http://u)", "http", &[]),
        // Every line break is a barrier: no match crosses from one line to the next.
        ("hey man\nyes\n\nz", "man yes", &[]),
        ("> hey man\n> yes", "man yes", &[]),
        ("- a\n  man\n  yes", "man yes", &[]),
        ("one\n\ntwo", "one two", &[]),
        ("- a\n- b", "a b", &[]),
        ("> a\n\nb", "a b", &[]),
        ("# h\nb", "h b", &[]),
        ("```\nx\ny\n```", "x y", &[]),
        ("```\nlet Foo;\n```", "foo", &["Foo"]),
        // Table cells are findable; pipes, delimiters and cell edges are barriers.
        ("| a | Bee |\n|---|---|\n| c | d |", "bee", &["Bee"]),
        ("| a | b |\n|---|---|\n| c | d |", "a | b", &[]),
        ("| a | b |\n|---|---|\n| c | d |", "b c", &[]),
        ("| a | b |\n|---|---|\n| c | d |", "|", &[]),
        ("| a | b |\n|---|---|\n| c | d |", "---", &[]),
        ("x\n\n| a\\|b | y |\n|---|---|\n\nx | y", "a|b", &["a|b"]),
        ("x\n\n| a | y |\n|---|---|\n\nx | y", "x | y", &["x | y"]),
        // Folding: every sigma is one letter; İ matches only itself.
        ("ΟΔΟΣΑ οδος", "οδοσ", &["ΟΔΟΣ", "οδος"]),
        ("İi", "i", &["i"]),
        ("abab", "abab", &["abab"]),
        ("aaaa", "aa", &["aa", "aa"]),
    ];
    for (source, query, expected) in cases {
        assert_eq!(found(source, query), *expected, "{source:?} / {query:?}");
    }
    assert_eq!(found("anything", ""), Vec::<String>::new());
    assert_eq!(found("a\nb", "a\nb"), Vec::<String>::new());
}

#[test]
fn stepping_wraps_selects_and_closes_without_editing() {
    let mut session = EditorSession::open("x one\nX two\n\nx **th**ree");
    let mut accepted = 0;
    let report = session.find_set_query(Revision(0), "x").unwrap();
    assert_eq!((report.total, report.current), (3, 1));
    assert_eq!(report.reveal, Some(range(0, 1)));
    assert!(!report.stale);

    let visit = |session: &mut EditorSession, direction| {
        let report = session.find_step(Revision(0), direction).unwrap();
        assert_eq!(session.selection(), report.reveal.unwrap());
        report.current
    };
    let forward: Vec<_> = (0..4)
        .map(|_| visit(&mut session, CaretDirection::Forward))
        .collect();
    assert_eq!(forward, [2, 3, 1, 2]);
    let backward: Vec<_> = (0..3)
        .map(|_| visit(&mut session, CaretDirection::Backward))
        .collect();
    assert_eq!(backward, [1, 3, 2]);

    // The current match maps to tight source bytes.
    session.find_set_query(Revision(0), "three").unwrap();
    let source = session.find_report().current_source.unwrap();
    assert_eq!(
        &session.source_text()[source.start.0..source.end.0],
        "th**ree"
    );

    // Closing clears matches, remembers the query and makes stepping a no-op.
    let closed = session.find_close();
    assert_eq!((closed.open, closed.total, closed.current), (false, 0, 0));
    assert_eq!(closed.query, "three");
    let selection = session.selection();
    let step = session
        .find_step(Revision(0), CaretDirection::Forward)
        .unwrap();
    assert_eq!((step.total, step.reveal), (0, None));
    assert_eq!(session.selection(), selection);

    // Zero matches: stepping is a no-op.
    let none = session.find_set_query(Revision(0), "zzz").unwrap();
    assert_eq!((none.total, none.current, none.reveal), (0, 0, None));
    let step = session
        .find_step(Revision(0), CaretDirection::Backward)
        .unwrap();
    assert_eq!(step.current, 0);

    // Find never edits source or history.
    assert_eq!(session.revision(), Revision(0));
    assert!(session
        .undo(Revision(0), &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .is_none());
    assert_eq!(accepted, 0);
    assert_eq!(session.source_text(), "x one\nX two\n\nx **th**ree");
}

#[test]
fn input_maps_matches_without_scanning_and_rejects_stale_scans() {
    let source = "cat one\n\ncat two\n\nbird cat three\n\ncat four";
    let mut session = EditorSession::open(source);
    session.find_set_query(Revision(0), "cat").unwrap();
    let request = session.find_scan_request().unwrap();
    let before = session.find_work();
    assert_eq!(before.scans, 1);

    // Typing costs no scan, and every match maps across the edit.
    let mut accept = |_: &futo_notes_editor::SourceEdit| Ok(());
    session
        .replace(Revision(0), range(4, 4), "ZZZ", &mut accept)
        .unwrap();
    assert_eq!(session.find_work(), before);
    let report = session.find_report();
    assert!(report.stale);
    assert_eq!(session.find_work(), before);
    let display = session.display_text();
    let mapped = session
        .find_matches(Revision(1), range(0, display.len()))
        .unwrap();
    assert_eq!(
        mapped,
        [range(0, 3), range(12, 15), range(26, 29), range(37, 40)]
    );
    for found in &mapped {
        assert_eq!(&display[found.start.0..found.end.0], "cat");
    }

    // A scan taken before the edit is rejected; a fresh one lands exactly.
    assert!(session.find_apply_scan(&request.run()).is_none());
    assert_eq!(session.find_work(), before);
    let fresh = session.find_scan_request().unwrap();
    let report = session.find_apply_scan(&fresh.run()).unwrap();
    assert_eq!((report.total, report.stale), (4, false));
    assert_eq!(session.find_work().scans, 2);

    // Closing and reopening invalidates an in-flight scan for the old query.
    let pending = session.find_scan_request().unwrap();
    session.find_close();
    session.find_set_query(Revision(1), "cat").unwrap();
    assert!(session.find_apply_scan(&pending.run()).is_none());

    // Another session at the same revision and query generation is not ours.
    let mut other = EditorSession::open(source);
    other.find_set_query(Revision(0), "cat").unwrap();
    let mut mine = EditorSession::open(source);
    mine.find_set_query(Revision(0), "cat").unwrap();
    let foreign = other.find_scan_request().unwrap().run();
    assert!(mine.find_apply_scan(&foreign).is_none());
    // Host matches out of order, overlapping, empty, out of range or inside a
    // character are rejected.
    let ours = mine.find_scan_request().unwrap().run();
    for matches in [
        vec![range(12, 15), range(0, 3)],
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
    let mut wide = EditorSession::open("é cat");
    wide.find_set_query(Revision(0), "cat").unwrap();
    let forged = FindScanResult {
        matches: vec![range(1, 6)],
        ..wide.find_scan_request().unwrap().run()
    };
    assert!(wide.find_apply_scan(&forged).is_none());
    assert!(mine
        .find_apply_scan(&mine.find_scan_request().unwrap().run())
        .is_some());

    // Many keystrokes never scan either, and a flood still ends consistent.
    let scans = session.find_work().scans;
    for revision in 1..=80u64 {
        let end = session.display_text().len();
        session
            .replace(Revision(revision), range(end, end), "!", &mut accept)
            .unwrap();
    }
    assert_eq!(session.find_work().scans, scans);
    let report = session.find_report();
    assert!(report.stale);
    let fresh = session.find_scan_request().unwrap();
    assert_eq!(session.find_apply_scan(&fresh.run()).unwrap().total, 4);
}

#[test]
fn table_barriers_scan_each_run_once_not_once_per_pipe_line() {
    let line = "a | b | c | d\n";
    let mut source = String::from("```\n");
    source.push_str(&line.repeat(4000));
    source.push_str("```\n\n| h | i |\n| - | - |\n| hit | x |\n");
    let mut session = EditorSession::open(&source);
    let report = session.find_set_query(Revision(0), "hit").unwrap();
    assert_eq!(report.total, 1);
    let bytes = session.find_work().barrier_bytes;
    assert!(
        bytes <= 2 * source.len() as u64,
        "barrier pass read {bytes} bytes of {}",
        source.len()
    );
}

#[test]
fn utf16_matches_read_native_windows_and_stepping_waits_out_composition() {
    use futo_notes_editor::{DisplayUtf16Offset, DisplayUtf16Range};
    let mut session = EditorSession::open("\u{1F600} cat cat");
    session.find_set_query(Revision(0), "cat").unwrap();
    let display = session.display_text();
    let all = session
        .find_matches(Revision(0), range(0, display.len()))
        .unwrap();
    let native = DisplayUtf16Range {
        start: DisplayUtf16Offset(0),
        end: DisplayUtf16Offset(display.encode_utf16().count()),
    };
    assert_eq!(session.find_matches_utf16(Revision(0), native), Ok(all));
    let split = DisplayUtf16Range {
        start: DisplayUtf16Offset(1),
        end: native.end,
    };
    assert!(session.find_matches_utf16(Revision(0), split).is_err());

    // Composition keeps the selection, so stepping keeps the current match.
    let before = session.find_report();
    session.compose(Revision(0), range(0, 0), "x").unwrap();
    let step = session
        .find_step(Revision(0), CaretDirection::Forward)
        .unwrap();
    assert_eq!((step.current, step.reveal), (before.current, None));
    assert_eq!(session.selection(), range(0, 0));
}
