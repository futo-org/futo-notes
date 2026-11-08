use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn inspect_tables_lists_every_table_in_a_range_in_one_call() {
    let raw = "- item\n- item\n\nintro\n\n| a | b |\n| --- | --- |\n| c | d |\n\n- tail\n\n| x |\n| - |\n| y |\n";
    let session = EditorSession::open(raw);
    let end = session.display_text().len();
    let all = session
        .inspect_tables(session.revision(), range(0, end))
        .unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!((all[0].columns, all[0].rows.len()), (2, 2));
    assert_eq!((all[1].columns, all[1].rows.len()), (1, 2));
    // Exactly what a per-block inspect_table sweep finds.
    let swept = session
        .project(session.revision(), range(0, end))
        .unwrap()
        .blocks
        .iter()
        .filter_map(|b| session.inspect_table(session.revision(), b.range).unwrap())
        .map(|t| t.display)
        .fold(Vec::new(), |mut out: Vec<DisplayRange>, d| {
            if !out.contains(&d) {
                out.push(d);
            }
            out
        });
    assert_eq!(all.iter().map(|t| t.display).collect::<Vec<_>>(), swept);
    let plain = EditorSession::open("- a\n- b\n");
    let end = plain.display_text().len();
    assert!(plain
        .inspect_tables(plain.revision(), range(0, end))
        .unwrap()
        .is_empty());
}

fn sweep(session: &EditorSession) -> Vec<DisplayRange> {
    let end = session.display_text().len();
    session
        .project(session.revision(), range(0, end))
        .unwrap()
        .blocks
        .iter()
        .filter_map(|b| session.inspect_table(session.revision(), b.range).unwrap())
        .map(|t| t.display)
        .fold(Vec::new(), |mut out: Vec<DisplayRange>, d| {
            if !out.contains(&d) {
                out.push(d);
            }
            out
        })
}

/// A piped first line heads a long nonblank run that holds no table: planning
/// reads the run once, not once per line. Quadratic before the fix (2,000 lines
/// took seconds in release, 8,000 took 40 s).
#[test]
fn inspect_tables_is_linear_over_a_nonblank_run_without_a_table() {
    let mut raw = String::from("a | b\n");
    for i in 0..6_000 {
        raw.push_str(&format!("line {i} words here\n"));
    }
    let session = EditorSession::open(&raw);
    let end = session.display_text().len();
    let started = std::time::Instant::now();
    let tables = session
        .inspect_tables(session.revision(), range(0, end))
        .unwrap();
    let elapsed = started.elapsed();
    assert!(tables.is_empty());
    assert!(elapsed.as_millis() < 1_500, "took {elapsed:?}");
}

/// The same cost without any `|`: the walk back to the run's start repeated
/// for every line.
#[test]
fn inspect_tables_is_linear_over_a_pipeless_run() {
    let mut raw = String::new();
    for i in 0..20_000 {
        raw.push_str(&format!("line {i} words here\n"));
    }
    let session = EditorSession::open(&raw);
    let end = session.display_text().len();
    let started = std::time::Instant::now();
    let tables = session
        .inspect_tables(session.revision(), range(0, end))
        .unwrap();
    let elapsed = started.elapsed();
    assert!(tables.is_empty());
    assert!(elapsed.as_millis() < 1_500, "took {elapsed:?}");
}

/// Headings with no blank line between them keep the whole note in one
/// projection row. Planning must still be linear: a per-line check that reads
/// the whole row made 12,000 lines take seconds (30,000 took minutes).
#[test]
fn inspect_tables_is_linear_over_headings_without_blank_lines() {
    let raw = "## Section heading\nfirst line of prose here\nsecond line of prose\n".repeat(4_000);
    let session = EditorSession::open(&raw);
    let end = session.display_text().len();
    let started = std::time::Instant::now();
    let tables = session
        .inspect_tables(session.revision(), range(0, end))
        .unwrap();
    let elapsed = started.elapsed();
    assert!(tables.is_empty());
    assert!(elapsed.as_millis() < 1_500, "took {elapsed:?}");
}

/// Sharing one read of a run must not change what is found: tables inside a
/// run that also holds plain lines, a pipe line that is no header, a table cut
/// short by a block start, and a table ending the note without a newline.
#[test]
fn inspect_tables_matches_the_per_block_sweep_inside_mixed_runs() {
    for raw in [
        "intro | pipe\nplain\n| a | b |\n| - | - |\n| c | d |\nafter\n\n| x |\n| - |\n| y |",
        "p\n| a | b |\n| - | - |\n| c | d |\n- item\n| e | f |\n| - | - |\n| g | h |\n",
        "one | two\nthree\nfour | five\n-- | --\nsix\n",
        "| a |\n| - |\n| x |\n| - |\n| y |\n\ntail | tail\nz\n",
        "| a | b |\n| - | - |\n| x | y |\n|\n| z | w |\n",
    ] {
        let session = EditorSession::open(raw);
        let end = session.display_text().len();
        let all: Vec<_> = session
            .inspect_tables(session.revision(), range(0, end))
            .unwrap()
            .iter()
            .map(|t| t.display)
            .collect();
        assert_eq!(all, sweep(&session), "{raw:?}");
    }
}

/// Every four-line note over lines that start, continue, interrupt or end
/// tables agrees with the per-block sweep.
#[test]
fn inspect_tables_matches_the_per_block_sweep_over_small_notes() {
    let pool = [
        "a | b",
        "| a | b |",
        "| - | - |",
        "- | -",
        "| x | y |",
        "text",
        "",
        "- item",
        "|",
    ];
    let mut checked = 0;
    for code in 0..pool.len().pow(4) {
        let raw: String = (0..4)
            .map(|i| format!("{}\n", pool[code / pool.len().pow(i as u32) % pool.len()]))
            .collect();
        let session = EditorSession::open(&raw);
        let end = session.display_text().len();
        let all: Vec<_> = session
            .inspect_tables(session.revision(), range(0, end))
            .unwrap()
            .iter()
            .map(|t| t.display)
            .collect();
        assert_eq!(all, sweep(&session), "{raw:?}");
        checked += 1;
    }
    assert_eq!(checked, 6_561);
}
