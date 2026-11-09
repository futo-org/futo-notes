use super::*;

/// Indent and Tab at the end of `source`, each on a fresh session: the bytes
/// the command writes, with the toolbar's `can_indent` required to agree.
fn indent_at_end(source: &str) -> String {
    let at_end = |source: &str| {
        let mut s = EditorSession::open(source);
        let end = s.display_text().len();
        s.select(s.revision(), range(end, end)).unwrap();
        (s, end)
    };
    let (mut s, end) = at_end(source);
    assert!(s.toolbar_state().can_indent, "{source:?}: can_indent");
    s.block_command(
        s.revision(),
        range(end, end),
        BlockCommand::Indent,
        &mut |_| Ok(()),
    )
    .unwrap_or_else(|error| panic!("{source:?}: Indent refused: {error:?}"))
    .unwrap_or_else(|| panic!("{source:?}: Indent did nothing"));
    let indented = s.source_text();
    s.undo(s.revision(), &mut |_| Ok(())).unwrap();
    assert_eq!(s.source_text(), source, "{source:?}: Undo of Indent");
    let (mut tab, end) = at_end(source);
    tab.paragraph_key(
        tab.revision(),
        range(end, end),
        ParagraphKey::Tab,
        &mut |_| Ok(()),
    )
    .unwrap_or_else(|error| panic!("{source:?}: Tab refused: {error:?}"));
    assert_eq!(tab.source_text(), indented, "{source:?}: Tab");
    indented
}

#[test]
fn an_empty_item_under_a_multi_line_sibling_indents_after_a_separating_blank_line() {
    for (source, indented) in [
        ("- a\n  continuation\n- ", "- a\n  continuation\n\n  - "),
        // A lazy continuation line and a hard break are still the sibling's paragraph.
        ("- a\ncontinuation\n- ", "- a\ncontinuation\n\n  - "),
        ("- a  \n  b\n- ", "- a  \n  b\n\n  - "),
        ("- a\n\n  b\n  c\n- ", "- a\n\n  b\n  c\n\n  - "),
        (
            "- a\n\n  | h | i |\n  | - | - |\n  | 1 | 2 |\n- ",
            "- a\n\n  | h | i |\n  | - | - |\n  | 1 | 2 |\n\n  - ",
        ),
        (
            "- | h | i |\n  | - | - |\n  | 1 | 2 |\n- ",
            "- | h | i |\n  | - | - |\n  | 1 | 2 |\n\n  - ",
        ),
        // Four spaces after an item's content column are a paragraph continuation, not code.
        (
            "- a\n    indented code\n- ",
            "- a\n    indented code\n\n  - ",
        ),
        ("> - a\n>   b\n> - ", "> - a\n>   b\n>\n>   - "),
        ("- a\r\n  b\r\n- ", "- a\r\n  b\r\n\r\n  - "),
        ("1. a\n   b\n2. ", "1. a\n   b\n\n   1. "),
    ] {
        assert_eq!(indent_at_end(source), indented, "{source:?}");
    }
}

/// Every list shape the Indent/Outdent eligibility is probed on: a first item,
/// the sibling block lines after it, an empty item, and optionally a later item.
/// Each comes with whether a later item follows the empty one.
fn eligibility_shapes() -> Vec<(String, bool)> {
    const FIRSTS: [&str; 3] = ["a", "a  ", "| h | i |"];
    // `I` marks a line indented to the item's content column.
    const TAILS: [&[&str]; 14] = [
        &[],
        &["I b"],
        &["b"],
        &["", "I b", "I c"],
        &["I     indented code"],
        &["I - sub"],
        &["I - sub", "I   more"],
        &["I | - | - |", "I | 1 | 2 |"],
        &["", "I | h | i |", "I | - | - |", "I | 1 | 2 |"],
        &["I ```", "I x", "I ```"],
        &["I > q"],
        &["I # h"],
        &["I <div>"],
        &["I ---", "I b"],
    ];
    let mut shapes = Vec::new();
    for container in ["", "> "] {
        for (marker, width) in [("- ", 2), ("1. ", 3), ("- [ ] ", 2)] {
            for first in FIRSTS {
                for tail in TAILS {
                    for after in [false, true] {
                        for eol in ["\n", "\r\n"] {
                            let pad = " ".repeat(width);
                            let mut lines = vec![format!("{container}{marker}{first}")];
                            for line in tail {
                                lines.push(match line.strip_prefix('I') {
                                    Some(text) => format!("{container}{pad}{}", &text[1..]),
                                    None => format!("{container}{line}"),
                                });
                            }
                            lines.push(format!("{container}{marker}"));
                            if after {
                                lines.push(format!("{container}{marker}c"));
                            }
                            shapes.push((lines.join(eol), after));
                        }
                    }
                }
            }
        }
    }
    shapes
}

/// The display offset of the end of the empty item's line.
fn empty_item_caret(source: &str, after: bool) -> usize {
    let display = EditorSession::open(source).display_text();
    let lines: Vec<&str> = display.split('\n').collect();
    let at = lines.len() - 1 - usize::from(after);
    let start: usize = lines[..at].iter().map(|line| line.len() + 1).sum();
    start + lines[at].trim_end_matches('\r').len()
}

#[test]
fn a_lit_indent_or_outdent_on_an_empty_item_is_never_refused_by_the_command() {
    let mut lit = 0;
    for (source, after) in eligibility_shapes() {
        let caret = empty_item_caret(&source, after);
        for (command, key) in [
            (BlockCommand::Indent, ParagraphKey::Tab),
            (BlockCommand::Outdent, ParagraphKey::ShiftTab),
        ] {
            let mut s = EditorSession::open(&source);
            s.select(s.revision(), range(caret, caret)).unwrap();
            let state = s.toolbar_state();
            let enabled = match command {
                BlockCommand::Indent => state.can_indent,
                _ => state.can_outdent,
            };
            if !enabled {
                continue;
            }
            lit += 1;
            let result =
                s.block_command(s.revision(), range(caret, caret), command, &mut |_| Ok(()));
            assert!(
                matches!(result, Ok(Some(_))),
                "{source:?} caret {caret}: {command:?} is lit but gave {result:?}"
            );
            let mut tab = EditorSession::open(&source);
            tab.select(tab.revision(), range(caret, caret)).unwrap();
            tab.paragraph_key(tab.revision(), range(caret, caret), key, &mut |_| Ok(()))
                .unwrap_or_else(|error| {
                    panic!("{source:?} caret {caret}: {key:?} refused: {error:?}")
                });
            assert_eq!(tab.source_text(), s.source_text(), "{source:?} {key:?}");
        }
    }
    assert!(lit > 1000, "the shapes must keep the toolbar lit: {lit}");
}
