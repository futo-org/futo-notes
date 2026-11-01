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
    "a [[Wiki link]] and ![img](a.png)",
    "footnote ref[^n]",
];
/// Blocks interleaved into some documents; cuts never enter them.
const BLOCKS: &[&str] = &[
    "<div>\nraw html\n</div>\n",
    "<!-- open comment\nstill inside\n-->\n",
    "[^n]: footnote body\n    continued\n",
    "| a | b |\n|---|---|\n| 1 | 2 |\n",
    "```\ncode\n```\n",
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

/// A raw record near a row boundary, or input or a key at a display caret.
fn choose(cut: &EditorSession, next: &mut impl FnMut(usize) -> usize) -> Step {
    if next(2) == 0 {
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
        // Raw records may open a fence or raw HTML block, or break a closer,
        // so their meaning reaches every later row (#313).
        const RAW: &[&str] = &["```", "```\n", "~~~\n", "<!--", "-->", "\n```\n"];
        let inserted = match next(3) {
            0 => RAW[next(RAW.len())],
            _ => EDITS[next(EDITS.len())],
        };
        Step::Raw(at, end, inserted)
    } else {
        let display = cut.display_text();
        let mut at = next(display.len());
        while !display.is_char_boundary(at) {
            at -= 1;
        }
        if next(3) == 0 {
            // Half the keys land on a line edge, where item joins stage a window.
            if next(2) == 0 {
                at = match next(2) {
                    0 => display[..at].rfind('\n').map_or(0, |line| line + 1),
                    _ => display[at..]
                        .find('\n')
                        .map_or(display.len(), |end| at + end),
                };
            }
            Step::Key(at, KEYS[next(KEYS.len())])
        } else {
            Step::Type(at, EDITS[next(EDITS.len())])
        }
    }
}

/// Turn the middle of `source` into one long fenced block (#314).
fn long_fence(source: &mut String, shape: usize, line_at: impl Fn(&str, usize) -> usize) {
    const FENCES: &[(&str, &str)] = &[
        ("```\n", "```\n"),
        ("```rust title\n", "```\n"),
        ("~~~~ py\n", "~~~~~\n"),
        ("  ```\n", "   ```\n"),
        ("````\n", "```\n````\n"),
    ];
    let (open, close) = FENCES[shape % FENCES.len()];
    let closed = shape / 5 % 2 == 0;
    // 0: top level, 1: in a quote, 2: in a list item.
    let (head, body) = [("", ""), ("> ", "> "), ("- ", "  ")][shape / 10 % 3];
    // An item fence past its content column panics the markdown crate when
    // a less indented ordered line follows (`-  ```\n  1. x\n`).
    let (open, close) = if head == "- " {
        (open.trim_start(), close.trim_start())
    } else {
        (open, close)
    };
    let at = line_at(source, source.len() / 8);
    let end = if closed {
        line_at(source, source.len() * 3 / 4)
    } else {
        source.len()
    };
    let mut fenced = format!("{head}{open}");
    for line in source[at..end].split_inclusive('\n') {
        fenced.push_str(body);
        fenced.push_str(line);
    }
    if closed {
        for line in close.split_inclusive('\n') {
            fenced.push_str(body);
            fenced.push_str(line);
        }
    }
    source.replace_range(at..end, &fenced);
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
        // Ordered lists cut only where markers equal ordinals; lazy `1.` stays uncut.
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
            if case % 5 == 2 && next(40) == 0 {
                source.push_str(BLOCKS[next(BLOCKS.len())]);
            }
        }
        if case % 10 == 4 {
            source.insert_str(0, "---\ntitle: front\n---\n");
        }
        let line_at = |source: &str, at: usize| {
            source.as_bytes()[..at]
                .iter()
                .rposition(|&byte| byte == b'\n')
                .map_or(0, |line| line + 1)
        };
        // A long fence: top-level, quoted or in an item, unclosed or closed.
        if case % 9 == 5 {
            long_fence(&mut source, case / 9, line_at);
        }
        // A long raw HTML block: unterminated, or closed partway.
        if case % 7 == 6 {
            let at = line_at(&source, source.len() / 8);
            source.insert_str(at, ["<!-- open\n", "<pre>\n", "<?php\n"][case % 3]);
            if case / 14 % 2 == 0 {
                let end = line_at(&source, source.len() * 3 / 4);
                source.insert_str(end, ["-->\n", "</pre>\n", "?>\n"][case % 3]);
            }
        }
        if case % 4 == 1 {
            source.push_str("\nafter\n");
        }
        // CRLF top-level fences. (Quoted CRLF paragraphs already differ:
        // input the uncut row refuses can be accepted in a cut row.)
        if case % 18 == 14 && case / 9 / 10 % 3 == 0 {
            source = source.replace('\n', "\r\n");
        }
        let mut cut = EditorSession::open(&source);
        let mut reference = uncut(|| EditorSession::open(&source));
        assert!(whole(&cut) == whole(&reference), "case {case} open");
        if case % 3 == 0
            && case % 5 != 2
            && case % 7 != 6
            && case % 9 != 5
            && !(ordered && case % 8 == 7)
        {
            assert!(cut.projection.rows.len() > 4, "case {case} is cut");
        }
        for index in 0..12 {
            let step = choose(&cut, &mut next);
            // Only the pinned markdown-crate panic (see the ignored test
            // below) stops a case; any other panic fails the fuzz.
            let referenced = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                uncut(|| run(&mut reference, &step))
            }));
            UNCUT.with(|uncut| uncut.set(false));
            if let Err(panic) = referenced {
                let message = panic
                    .downcast_ref::<String>()
                    .map(String::as_str)
                    .or_else(|| panic.downcast_ref::<&str>().copied())
                    .unwrap_or("");
                let pinned = ["mismatched (non-jsx): List", "Cannot push to non-parent"];
                if !pinned.iter().any(|known| message.contains(known)) {
                    std::panic::resume_unwind(panic);
                }
                break;
            }
            run(&mut cut, &step);
            let (got, want) = (whole(&cut), whole(&reference));
            // Every step must leave the twin equal to a fresh open.
            let fresh = uncut(|| whole(&EditorSession::open(&want.0)));
            assert!(want == fresh, "case {case} step {index}: twin is stale");
            // Uncut input may respell distant lines of its whole-paragraph
            // context; a cut result must still show the same meaning and
            // agree with a fresh open of its own source.
            let same_meaning = |a: &ProjectionSlice, b: &ProjectionSlice| {
                a.text == b.text && a.runs == b.runs && a.blocks == b.blocks && a.links == b.links
            };
            let ok = got == want
                || (same_meaning(&got.1, &want.1)
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

#[test]
fn only_kind_one_tag_names_cut_html_blocks() {
    let body = "line of raw html\n".repeat(200);
    for (opener, cut) in [
        ("<pre>\n", true),
        ("<script\n", true),
        ("<prefix>\n", false),
    ] {
        let projection = super::Projection::new(&format!("{opener}{body}"));
        assert_eq!(projection.rows.len() > 1, cut, "{opener:?}");
    }
}

/// markdown 1.0.0's `to_mdast` (the declaration scan) panics on these
/// inputs, so opening or typing them crashes the editor: an item fence past
/// its content column meeting a shallower ordered line ("mismatched"), and a
/// list item typed at the end of a line after a `-`/`--` pair ("Cannot push to non-parent"). The
/// twin fuzz stops a case only on these exact panics. Un-ignore once the
/// scan cannot panic.
#[test]
#[ignore = "known markdown-crate panics in the declaration scan"]
fn declaration_scan_survives_an_item_fence_before_a_shallower_ordered_line() {
    let _ = EditorSession::open("-  ```\n  1. x\n[a]: b\n");
}

#[test]
#[ignore = "known markdown-crate panics in the declaration scan"]
fn declaration_scan_survives_an_item_typed_after_dash_lines() {
    let source = "title: front\n-\n--\nescaped \\* star and 3 * 4 56\n";
    let mut session = EditorSession::open(source);
    let end = session.display_text().trim_end().len();
    let _ = session.replace(session.revision(), range(end, end), "\n- ", &mut |_| Ok(()));
}
