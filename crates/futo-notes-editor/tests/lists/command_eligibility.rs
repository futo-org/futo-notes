//! The toolbar's Indent and Outdent state against the commands, on every row
//! of generated list shapes: a button is lit exactly when its command (and the
//! Tab key that runs it) applies, and one Undo restores the exact bytes.
use super::*;

/// What each template line is prefixed with by one container and one marker.
struct Spelling {
    /// The first line's container prefix and the other lines'.
    first: &'static str,
    rest: &'static str,
    marker: &'static str,
    /// The content column's width after the container prefix.
    pad: &'static str,
}

/// A template line: `M` an item marker, `I` an indent to the item's content
/// column, `N` and `O` a nested and a doubly nested item, `L` a lazy line and
/// `R` a raw one; the rest of the line is its text.
fn spell(line: &str, spelling: &Spelling, opened: &mut bool) -> String {
    let (kind, text) = line.split_at(1);
    let prefix = if std::mem::replace(opened, true) {
        spelling.rest
    } else {
        spelling.first
    };
    match kind {
        "M" => format!("{prefix}{}{text}", spelling.marker),
        "I" => format!("{prefix}{}{text}", spelling.pad),
        "N" => format!("{prefix}{}- {text}", spelling.pad),
        "O" => format!("{prefix}{}  - {text}", spelling.pad),
        "L" | "R" => format!("{prefix}{text}"),
        _ => unreachable!("{line}"),
    }
}

/// Item lines after a first item `a`, each a different block the sibling
/// below has to coexist with (`I` an indented line, `N` and `O` a nested
/// and a doubly nested item, `L` a lazy line, `R` a blank one).
const TAILS: [&[&str]; 22] = [
    &[],
    &["Ib"],
    &["Lb"],
    &["R", "Ib", "Ic"],
    &["I    indented code"],
    &["Nsub"],
    &["Nsub", "I  more"],
    &["Nsub", "Odeep"],
    &["N"],
    &["Nsub", "N"],
    &["Nsub", "Nsub"],
    &["N", "N"],
    &["Nsub", "Odeep", "N"],
    &["Nsub", "O", "Nsub"],
    &["I| - | - |", "I| 1 | 2 |"],
    &["R", "I| h | i |", "I| - | - |", "I| 1 | 2 |"],
    &["I```", "Ix", "I```"],
    &["I```", "Ix"],
    &["I> q"],
    &["I# h"],
    &["I<div>"],
    &["I---", "Ib"],
];

/// The lines that follow the first item and its tail.
const AFTERS: [&[&str]; 8] = [
    &[],
    &["M"],
    &["M", "M"],
    &["Mc"],
    &["M", "Mc"],
    &["Mb", "Ix", "M"],
    &["M", "Ix", "Mc"],
    &["M", "N"],
];

fn shapes() -> Vec<String> {
    let spellings = [
        Spelling {
            first: "",
            rest: "",
            marker: "- ",
            pad: "  ",
        },
        Spelling {
            first: "",
            rest: "",
            marker: "* ",
            pad: "  ",
        },
        Spelling {
            first: "",
            rest: "",
            marker: "2. ",
            pad: "   ",
        },
        Spelling {
            first: "",
            rest: "",
            marker: "1) ",
            pad: "   ",
        },
        Spelling {
            first: "",
            rest: "",
            marker: "- [ ] ",
            pad: "  ",
        },
        Spelling {
            first: "> ",
            rest: "> ",
            marker: "- ",
            pad: "  ",
        },
        Spelling {
            first: "> ",
            rest: "> ",
            marker: "1. ",
            pad: "   ",
        },
    ];
    let mut shapes = Vec::new();
    for (index, spelling) in spellings.iter().enumerate() {
        for first in ["Ma", "M", "Ma  ", "M| h | i |"] {
            for tail in TAILS {
                for after in AFTERS {
                    // Items opening on a block, bare ones and the quoted containers
                    // get the short tails only: the matrix would otherwise dwarf
                    // the suite.
                    let plain = first == "Ma";
                    if !plain && tail.len() > 2 || index > 3 && tail.len() > 3 {
                        continue;
                    }
                    let mut opened = false;
                    let lines: Vec<String> = std::iter::once(&first)
                        .chain(tail.iter())
                        .chain(after.iter())
                        .map(|line| spell(line, spelling, &mut opened))
                        .collect();
                    shapes.push(lines.join("\n"));
                    if index % 2 == 0 {
                        shapes.push(lines.join("\r\n"));
                    }
                    // A trailing line ending, and a paragraph above.
                    if index % 2 == 1 {
                        shapes.push(format!("{}\n", lines.join("\n")));
                    }
                    if index == 0 {
                        shapes.push(format!("para\n\n{}", lines.join("\n")));
                    }
                }
            }
        }
    }
    // A list that starts inside a quote inside an item is outside the generic
    // list edit: neither button lights anywhere on it.
    for source in ["- > - a\n  > - ", "- > - a\n  > - c", "- > - \n  >   > q"] {
        shapes.push(source.to_owned());
    }
    shapes.sort();
    shapes.dedup();
    shapes
}

fn carets(source: &str) -> Vec<usize> {
    let display = EditorSession::open(source).display_text();
    let mut carets = Vec::new();
    let mut start = 0;
    for line in display.split('\n') {
        carets.push(start + line.trim_end_matches('\r').len());
        start += line.len() + 1;
    }
    carets.dedup();
    carets
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Indent,
    Outdent,
    Tab,
    ShiftTab,
}

/// The state the button shows, and the command's result with the document it
/// leaves; `None` for the document when the command did not apply.
fn run(
    source: &str,
    caret: usize,
    action: Action,
) -> (bool, bool, bool, bool, Result<Option<String>, String>) {
    let mut s = EditorSession::open(source);
    s.select(s.revision(), range(caret, caret)).unwrap();
    let state = s.toolbar_state();
    let lit = match action {
        Action::Indent | Action::Tab => state.can_indent,
        Action::Outdent | Action::ShiftTab => state.can_outdent,
    };
    let in_list = state.list.is_some();
    let result = match action {
        Action::Indent | Action::Outdent => {
            let command = if action == Action::Indent {
                BlockCommand::Indent
            } else {
                BlockCommand::Outdent
            };
            s.block_command(s.revision(), range(caret, caret), command, &mut |_| Ok(()))
        }
        Action::Tab | Action::ShiftTab => {
            let key = if action == Action::Tab {
                ParagraphKey::Tab
            } else {
                ParagraphKey::ShiftTab
            };
            s.paragraph_key(s.revision(), range(caret, caret), key, &mut |_| Ok(()))
        }
    };
    let result = match result {
        Err(error) => Err(format!("{error:?}")),
        Ok(None) => Ok(None),
        Ok(Some(_)) => {
            let edited = s.source_text();
            match s.undo(s.revision(), &mut |_| Ok(())) {
                Ok(Some(_)) if s.source_text() == source => Ok(Some(edited)),
                other => Err(format!("Undo gave {:?}", other.map(|c| c.is_some()))),
            }
        }
    };
    (lit, in_list, state.quote, state.code, result)
}

#[test]
fn a_lit_indent_or_outdent_is_exactly_a_command_that_applies() {
    let (mut checked, mut lit_total) = (0, 0);
    let mut failures: Vec<String> = Vec::new();
    let mut failed_shapes = std::collections::BTreeSet::new();
    let mut buckets = std::collections::BTreeMap::new();
    for source in shapes() {
        for caret in carets(&source) {
            let mut indented = None;
            let mut outdented = None;
            for action in [
                Action::Indent,
                Action::Outdent,
                Action::Tab,
                Action::ShiftTab,
            ] {
                let (lit, in_list, quoted, code, result) = run(&source, caret, action);
                // A row outside every list is the quote commands' business.
                if !in_list {
                    continue;
                }
                checked += 1;
                lit_total += usize::from(lit);
                // Tab is an indent key on list rows only: not on a quote inside
                // an item, and a code row's Tab types its own indentation.
                let tab = matches!(action, Action::Tab | Action::ShiftTab);
                let applies = matches!(result, Ok(Some(_)));
                let note = if tab && (quoted || code) {
                    None
                } else if lit != applies {
                    Some(format!("lit {lit} but {result:?}"))
                } else {
                    None
                };
                // Tab runs the toolbar's command byte for byte.
                match (action, &result) {
                    (Action::Indent, Ok(Some(text))) => indented = Some(text.clone()),
                    (Action::Outdent, Ok(Some(text))) => outdented = Some(text.clone()),
                    _ => {}
                }
                let note = note.or_else(|| match (action, &result) {
                    (Action::Tab, Ok(Some(text))) if !code && Some(text) != indented.as_ref() => {
                        Some(format!("Tab {text:?} differs from Indent {indented:?}"))
                    }
                    (Action::ShiftTab, Ok(Some(text)))
                        if !code && Some(text) != outdented.as_ref() =>
                    {
                        Some(format!(
                            "Shift+Tab {text:?} differs from Outdent {outdented:?}"
                        ))
                    }
                    (_, Err(error)) if lit || error.starts_with("Undo") => Some(error.clone()),
                    _ => None,
                });
                if let Some(note) = note {
                    let kind = format!("{action:?} lit {lit}: {}", note.split(' ').next().unwrap());
                    *buckets.entry(kind).or_insert(0usize) += 1;
                    failed_shapes.insert(source.clone());
                    if failures.len() < 40 {
                        failures.push(format!("{source:?} caret {caret} {action:?}: {note}"));
                    }
                }
            }
        }
    }
    assert!(
        lit_total > 5000,
        "the shapes must keep the toolbar lit: {lit_total}"
    );
    assert!(
        failed_shapes.is_empty(),
        "{} shapes failed over {checked} checks ({lit_total} lit): {buckets:?}; first:\n{}",
        failed_shapes.len(),
        failures.join("\n")
    );
}

#[test]
fn the_repairs_write_the_minimal_separators_and_refuse_nothing_they_light() {
    for (source, caret, action, expected) in [
        // A bare `-` below paragraph text would read as a setext underline.
        ("- a\n- ", 1, Action::Outdent, "a\n\n- "),
        ("- a\r\n- ", 1, Action::Outdent, "a\r\n\r\n- "),
        ("> - a\n> - ", 1, Action::Outdent, "> a\n>\n> - "),
        ("- a\n  - b\n  - ", 2, Action::Outdent, "- a\n- b\n\n  - "),
        ("- a\n- b\n  x\n- ", 2, Action::Outdent, "- a\n\nb\nx\n\n- "),
        // An item that is itself a setext heading, a raw HTML block and a
        // divider move with their lines.
        ("- a\n  - ", 1, Action::Outdent, "a\n- "),
        ("- a\n  <div>\n- b", 0, Action::Outdent, "a\n<div>\n\n- b"),
        ("- a\n  ---\n  b", 0, Action::Outdent, "a\n---\nb"),
        // An unclosed fence is closed where the item that ended it moves.
        (
            "- a\n  ```\n  x\n- c",
            0,
            Action::Outdent,
            "a\n```\nx\n```\n- c",
        ),
        (
            "- a\n  ```\n  x\n- c",
            4,
            Action::Indent,
            "- a\n  ```\n  x\n  ```\n  - c",
        ),
    ] {
        let (lit, _, _, _, result) = run(source, caret, action);
        assert!(lit, "{source:?} caret {caret}: {action:?} is not lit");
        assert_eq!(
            result,
            Ok(Some(expected.to_owned())),
            "{source:?} {action:?}"
        );
    }
}

#[test]
fn items_and_quotes_the_generic_edit_cannot_reach_light_nothing() {
    // Items sharing a line with the item they sit in through a quote, and an
    // item whose own line opens a quote.
    for source in ["- > - a\n  > - ", "- > - a", "- > - \n  >   > q", "- > q"] {
        for caret in carets(source) {
            for action in [
                Action::Indent,
                Action::Outdent,
                Action::Tab,
                Action::ShiftTab,
            ] {
                let (lit, _, _, _, result) = run(source, caret, action);
                assert!(
                    !lit && !matches!(result, Ok(Some(_))),
                    "{source:?} caret {caret} {action:?}: lit {lit} {result:?}"
                );
            }
        }
    }
}
