//! Nested lists cut between siblings at any depth must behave exactly like
//! an uncut twin through engine input and raw source records.
use super::split_tests::{difference, twin_steps, uncut, whole};
use crate::EditorSession;

/// Item bodies for nested lists: inline syntax, headings, tasks and the
/// rarer shapes that keep a list uncut or a line from starting a row.
const NESTED: &[&str] = &[
    "plain item words",
    "### heading item",
    "1d4 [giant owl](https://example.com/owl)s",
    "**d100**",
    "with *em* and `code`",
    "[ ] open task",
    "[x] done task",
    "a [[Wiki link]] here",
    "- same-line child",
    "",
];
/// Lines that make a nested list unusual: lazy text, blank lines, tabs,
/// code, quotes and raw HTML.
const NESTED_ODD: &[&str] = &[
    "lazy continuation text",
    "",
    "\t- tabbed item",
    "```\ncode\n```",
    "> quoted",
    "<div>\nhtml\n</div>",
    "#### loose heading",
];

/// A nested list of `lines` items whose depth walks up and down.
fn nested_list(case: usize, lines: usize, next: &mut impl FnMut(usize) -> usize) -> String {
    let ordered = case % 3 == 1;
    let mut source = String::new();
    let mut depth = 0usize;
    // Item counts per depth for ordinals.
    let mut counts = [0usize; 8];
    for line in 0..lines {
        depth = match next(4) {
            0 => depth.saturating_sub(1 + next(3)),
            1 | 2 => (depth + 1).min(6),
            _ => depth,
        };
        counts[depth] += 1;
        counts[depth + 1..].fill(0);
        let width = if case % 5 == 4 { 2 } else { 4 };
        let indent = " ".repeat(width * depth);
        let marker = if ordered && depth.is_multiple_of(2) {
            // Mostly the ordinal, sometimes a lazy `1.`.
            let number = if next(9) == 0 { 1 } else { counts[depth] };
            format!("{number}.")
        } else {
            "-".to_owned()
        };
        let body = NESTED[next(NESTED.len())];
        source.push_str(&format!("{indent}{marker} {body} {line}\n"));
        // Blank and whitespace-only lines between items (a loose list).
        if case % 4 == 2 && next(12) == 0 {
            source.push_str(["\n", "  \n", &format!("{indent}    \n")][next(3)]);
        }
        if case % 4 == 3 && next(60) == 0 {
            let odd = NESTED_ODD[next(NESTED_ODD.len())];
            for part in odd.split('\n') {
                source.push_str(&format!("{indent}  {part}\n"));
            }
        }
    }
    source
}

#[test]
fn cut_nested_lists_match_uncut_twin_through_edits() {
    let mut seed = 0x1b87_3593_9e37_79b9u64;
    let mut next = move |bound: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % bound as u64) as usize
    };
    let cases = std::env::var("SPLIT_CASES").map_or(24, |cases| cases.parse().unwrap());
    for case in 0..cases {
        let mut source = nested_list(case, 300, &mut next);
        if case % 6 == 5 {
            source.insert_str(0, "intro paragraph\n\n");
            source.push_str("\nafter\n");
        }
        let mut cut = EditorSession::open(&source);
        let mut reference = uncut(|| EditorSession::open(&source));
        assert!(
            whole(&cut) == whole(&reference),
            "case {case} open: {}\n{}",
            difference(&cut, &reference),
            {
                let mut rows = String::new();
                let mut at = 0;
                for index in 0..cut.projection.rows.len() {
                    let row = cut.projection.rows.at(index).0;
                    rows.push_str(&format!("row {at} ctx {:?}\n", row.context));
                    at += row.source_len;
                }
                format!("{rows}{source}")
            }
        );
        // Two-space nesting under same-line children can indent code.
        let plain = case % 4 != 3 && case % 3 != 1 && case % 5 != 4;
        if plain {
            assert!(cut.projection.rows.len() > 4, "case {case} is cut");
        }
        if plain {
            let contexts = (0..cut.projection.rows.len())
                .filter(|&row| cut.projection.rows.at(row).0.context.is_some())
                .count();
            assert!(contexts > 2, "case {case} cuts inside nested items");
        }
        let steps = std::env::var("NESTED_STEPS").map_or(16, |steps| steps.parse().unwrap());
        twin_steps(&mut cut, &mut reference, case, steps, &mut next);
    }
}
