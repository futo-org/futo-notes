//! A session with cut paragraphs and lists must behave exactly like a twin session whose
//! rows are never cut, through engine input and raw source records that unseal
//! a cut or reach across it.
use super::row::UNCUT;
use crate::{
    DisplayOffset, DisplayRange, EditorSession, ParagraphKey, ProjectionSlice, Revision,
    SourceEdit, SourceOffset, SourceRange,
};

fn uncut<T>(run: impl FnOnce() -> T) -> T {
    UNCUT.with(|uncut| uncut.set(true));
    let result = run();
    UNCUT.with(|uncut| uncut.set(false));
    result
}

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

fn whole(session: &EditorSession) -> (String, ProjectionSlice, String) {
    let end = session.projection.display.len_bytes();
    let lines: Vec<_> = session
        .projection
        .list_command_lines(range(0, end))
        .into_iter()
        .map(|line| (line.source, line.list, line.task))
        .collect();
    (
        session.source_text(),
        session.projection.query(Revision(0), range(0, end)),
        format!("{lines:?}"),
    )
}

const LINES: &[&str] = &[
    "with *em* and **strong** text",
    "a `code` span and a_b word",
    "[link](https://x.y) and ~~gone~~",
    "escaped \\* star and 3 * 4",
    "hard break  ",
    "backslash break\\",
    "  indented continuation",
    "2. not a list here",
    "<span title=x>tag</span> after",
    "x < y and [bracket] text",
    "Ünïcode wörds ✓",
];
const EDITS: &[&str] = &[
    "x", "*", "`", "[", "]", "\n", "  ", "\\", "- ", "# ", "\n===", "_", "<b", "\n\n", "```", "> ",
    "1. ", "**", "\n- ", "* ", "[ ] ",
];

const ITEMS: &[&str] = &[
    "  - nested item",
    "- [ ] open task",
    "- [x] done task",
    "- a `code` item",
    "- with *em* item",
    "-   wide item",
    "* other bullet",
    "lazy continuation",
    "  ```fence in item",
];
const ORDERED: &[&str] = &[
    "   - nested item",
    "   1. nested ordered",
    "1) other delimiter",
    "10. wide number",
    "lazy continuation",
    "   ```fence in item",
];
const KEYS: &[ParagraphKey] = &[
    ParagraphKey::Enter,
    ParagraphKey::Backspace,
    ParagraphKey::Delete,
    ParagraphKey::Tab,
    ParagraphKey::ShiftTab,
];

enum Step {
    Raw(usize, usize, &'static str),
    Key(usize, ParagraphKey),
    Type(usize, &'static str),
}

fn run(session: &mut EditorSession, step: &Step) {
    let revision = session.revision();
    match *step {
        Step::Raw(at, end, inserted) => {
            let source = session.source_text();
            session
                .replay(&SourceEdit {
                    previous_revision: revision,
                    revision: Revision(revision.0 + 1),
                    range: SourceRange {
                        start: SourceOffset(at),
                        end: SourceOffset(end),
                    },
                    removed: source[at..end].to_owned(),
                    inserted: inserted.to_owned(),
                })
                .unwrap();
        }
        Step::Key(at, key) => {
            let _ = session.paragraph_key(revision, range(at, at), key, &mut |_| Ok(()));
        }
        Step::Type(at, text) => {
            let _ = session.replace(revision, range(at, at), text, &mut |_| Ok(()));
        }
    }
}

#[test]
fn cut_paragraphs_match_uncut_twin_through_edits() {
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = move |bound: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % bound as u64) as usize
    };
    let cases = std::env::var("SPLIT_CASES").map_or(24, |cases| cases.parse().unwrap());
    for case in 0..cases {
        let list = case % 2 == 1;
        // Ordered lists stay uncut; they guard against numbering drift.
        let ordered = case % 4 == 3;
        let mut source = String::new();
        for line in 0..400 {
            let number = if case % 8 == 7 { 1 } else { line + 1 };
            let text = if list && ordered {
                if case % 3 == 0 || next(5) != 0 {
                    format!("{number}. list item")
                } else {
                    ORDERED[next(ORDERED.len())].to_owned()
                }
            } else if list {
                if case % 3 == 0 || next(5) != 0 {
                    "- list item".to_owned()
                } else {
                    ITEMS[next(ITEMS.len())].to_owned()
                }
            } else if case % 3 == 0 || next(4) != 0 {
                "plain words here".to_owned()
            } else if case % 6 == 4 && next(8) == 0 {
                ["*opens here", "closes here*"][next(2)].to_owned()
            } else {
                LINES[next(LINES.len())].to_owned()
            };
            source.push_str(&format!("{text} {line}\n"));
        }
        if case % 4 == 1 {
            source.push_str("\nafter\n");
        }
        let mut cut = EditorSession::open(&source);
        let mut reference = uncut(|| EditorSession::open(&source));
        assert!(whole(&cut) == whole(&reference), "case {case} open");
        if case % 3 == 0 && !ordered {
            assert!(cut.projection.rows.len() > 4, "case {case} is cut");
        }
        for index in 0..12 {
            let step = if next(2) == 0 {
                // Raw source near a cut, bypassing literal input spelling.
                let source = cut.source_text();
                let mut base = 0;
                let starts: Vec<usize> = (0..cut.projection.rows.len())
                    .map(|row| {
                        let at = base;
                        base += cut.projection.rows.at(row).0.source_len;
                        at
                    })
                    .collect();
                let mut at = (starts[next(starts.len())] + next(9)).saturating_sub(4);
                at = at.min(source.len());
                while !source.is_char_boundary(at) {
                    at -= 1;
                }
                let mut end = (at + next(3)).min(source.len());
                while !source.is_char_boundary(end) {
                    end += 1;
                }
                // Raw backticks are excluded: an unclosed fence reaching past
                // blank lines is #313 work for both twins, and mismatched code
                // runs make uncut input respell distant spans in the paragraph.
                let inserted = EDITS[next(EDITS.len())];
                Step::Raw(
                    at,
                    end,
                    if inserted.contains('`') {
                        "x"
                    } else {
                        inserted
                    },
                )
            } else {
                let display = cut.display_text();
                let mut at = next(display.len());
                while !display.is_char_boundary(at) {
                    at -= 1;
                }
                if next(3) == 0 {
                    Step::Key(at, KEYS[next(KEYS.len())])
                } else {
                    Step::Type(at, EDITS[next(EDITS.len())])
                }
            };
            run(&mut cut, &step);
            uncut(|| run(&mut reference, &step));
            let (got, want) = (whole(&cut), whole(&reference));
            // Incremental rows that already disagree with a fresh open (for
            // example blank lines after a list) predate cuts; stop comparing.
            if want != uncut(|| whole(&EditorSession::open(&want.0))) {
                break;
            }
            // Uncut input may respell distant lines of its whole-paragraph
            // context; a cut result must still show the same meaning and
            // agree with a fresh open of its own source.
            let same_meaning = |a: &ProjectionSlice, b: &ProjectionSlice| {
                a.text == b.text && a.runs == b.runs && a.blocks == b.blocks && a.links == b.links
            };
            let ok = got == want
                || (!list
                    && same_meaning(&got.1, &want.1)
                    && got == uncut(|| whole(&EditorSession::open(&got.0))));
            let step = match step {
                Step::Raw(at, end, text) => format!("raw {at}..{end} {text:?}"),
                Step::Key(at, key) => format!("key {key:?} at {at}"),
                Step::Type(at, text) => format!("type {text:?} at {at}"),
            };
            assert!(ok, "case {case} step {index}: {step}");
            if got != want {
                // Continue from the cut twin's spelling.
                reference = uncut(|| EditorSession::open(&got.0));
            }
        }
    }
}
