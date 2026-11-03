//! Word-seam rows against a twin cut only at line seams (#314).
use super::super::row::NO_WORD_SEAMS;
use super::*;

/// The engine without word seams: rows cut only at blank lines and line seams.
fn line_cut<T>(run: impl FnOnce() -> T) -> T {
    NO_WORD_SEAMS.with(|plain| plain.set(true));
    let result = run();
    NO_WORD_SEAMS.with(|plain| plain.set(false));
    result
}

/// Long lines cut at word seams behave exactly like their twin cut only at
/// line seams (the engine before word seams), through input, keys and raw
/// records that land on or beside a seam (#314), and agree with a fresh open.
#[test]
fn word_seams_match_line_cut_twin_through_edits() {
    let mut seed =
        std::env::var("SPLIT_SEED").map_or(0x51f1_5eed_d0c5_a11du64, |seed| seed.parse().unwrap());
    let mut next = move |bound: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % bound.max(1) as u64) as usize
    };
    const WORDS: &[&str] = &[
        "duck",
        "eggs",
        "usually",
        "take",
        "days",
        "to",
        "hatch",
        ",",
        ".",
        "a",
        "incubator",
        "x",
        "www",
        "http",
        "amp",
        "Lorem",
    ];
    const SEAM_EDITS: &[&str] = &[
        "x",
        " ",
        "*",
        "`",
        "[",
        "]",
        "\n",
        "  ",
        "\\",
        "_",
        "<",
        "&",
        ";",
        ".",
        "\n\n",
        "**",
        "# ",
        "- ",
        "1. ",
        "é",
        "ab",
        ":",
        "@",
        "~",
        "=",
        "\n===",
        "\n- ",
        "|",
        "\n| --- | --- |\n",
        "| a |",
        "[[",
        "]]",
    ];
    let cases = std::env::var("SPLIT_CASES").map_or(40, |cases| cases.parse().unwrap());
    let mut stale = 0;
    let mut divergent = 0;
    let mut steps = 0;
    for case in 0..cases {
        let mut source = String::new();
        for _ in 0..1 + case % 3 {
            let len = 2_500 + next(4_000);
            let start = source.len();
            while source.len() - start < len {
                let word = if case % 4 == 3 && next(30) == 0 {
                    LINES[next(LINES.len())]
                } else {
                    WORDS[next(WORDS.len())]
                };
                source.push_str(word);
                source.push(if case % 5 == 4 && next(60) == 0 {
                    '\n'
                } else {
                    ' '
                });
            }
            source.push_str(["\n\n", "\n\n", "\n"][next(3)]);
            if case % 6 == 5 {
                source.push_str("- item\n\n");
            }
            if case % 8 == 2 {
                source.push_str("| head | b |\n| --- | --- |\n");
            }
        }
        if case % 7 == 6 {
            source.pop();
        }
        let mut cut = EditorSession::open(&source);
        let mut reference = line_cut(|| EditorSession::open(&source));
        assert!(whole(&cut) == whole(&reference), "case {case} open");
        if case % 4 != 3 && case % 5 != 4 {
            assert!(
                (0..cut.projection.rows.len()).any(|i| cut.projection.rows.at(i).0.mid_line),
                "case {case} has a word seam"
            );
        }
        for index in 0..16 {
            // Most steps land within a few bytes of a row boundary.
            let row = next(cut.projection.rows.len());
            let (_, source_at, display_at) = cut.projection.rows.at(row);
            let step = match next(4) {
                0 => choose(&cut, &mut next),
                1 => {
                    let text = cut.source_text();
                    let mut at = (source_at + next(7)).saturating_sub(3).min(text.len());
                    while !text.is_char_boundary(at) {
                        at -= 1;
                    }
                    let mut end = (at + next(3)).min(text.len());
                    while !text.is_char_boundary(end) {
                        end += 1;
                    }
                    Step::Raw(at, end, SEAM_EDITS[next(SEAM_EDITS.len())])
                }
                _ => {
                    let display = cut.display_text();
                    let mut at = (display_at + next(7)).saturating_sub(3).min(display.len());
                    while !display.is_char_boundary(at) {
                        at -= 1;
                    }
                    if next(4) == 0 {
                        Step::Key(at, KEYS[next(KEYS.len())])
                    } else {
                        Step::Type(at, SEAM_EDITS[next(SEAM_EDITS.len())])
                    }
                }
            };
            let label = match step {
                Step::Raw(at, end, text) => format!("raw {at}..{end} {text:?}"),
                Step::Key(at, key) => format!("key {key:?} at {at}"),
                Step::Type(at, text) => format!("type {text:?} at {at}"),
            };
            let before = cut.source_text();
            line_cut(|| run(&mut reference, &step));
            run(&mut cut, &step);
            steps += 1;
            let (got, want) = (whole(&cut), line_cut(|| whole(&reference)));
            if want != line_cut(|| whole(&EditorSession::open(&want.0))) {
                // The line-cut engine's own incremental gap, not a word seam:
                // continue from fresh twins.
                stale += 1;
                eprintln!("case {case} step {index}: {label}: line-cut twin is stale");
                cut = EditorSession::open(&got.0);
                reference = line_cut(|| EditorSession::open(&got.0));
                continue;
            }
            // A cut session always equals a fresh open of its own source.
            assert!(
                got == whole(&EditorSession::open(&got.0)),
                "case {case} step {index}: {label} differs from a fresh open"
            );
            if got == want {
                continue;
            }
            // The line-cut row holds the whole long line, so its input can
            // refuse, or respell, at source far from the caret (raw fences,
            // entities, table pipes there). A word-seam row then changes only
            // bytes at the edit; its result must equal a line-cut open of its
            // source. A respelling must keep the meaning shown.
            let same_meaning = |a: &ProjectionSlice, b: &ProjectionSlice| {
                a.text == b.text && a.runs == b.runs && a.blocks == b.blocks && a.links == b.links
            };
            let prefix = before
                .bytes()
                .zip(got.0.bytes())
                .take_while(|(a, b)| a == b)
                .count();
            let suffix = before[prefix..]
                .bytes()
                .rev()
                .zip(got.0[prefix..].bytes().rev())
                .take_while(|(a, b)| a == b)
                .count();
            let local = before.len() - prefix - suffix <= 16 && got.0.len() - prefix - suffix <= 32;
            let refused = want.0 == before
                && local
                && got == line_cut(|| whole(&EditorSession::open(&got.0)));
            assert!(
                refused || same_meaning(&got.1, &want.1),
                "case {case} step {index}: {label}"
            );
            divergent += 1;
            reference = line_cut(|| EditorSession::open(&got.0));
        }
    }
    // Stale and divergent twins stay the exception.
    assert!(
        (stale + divergent) * 50 <= steps,
        "{stale} stale and {divergent} divergent of {steps} steps"
    );
}
