//! Indent and Outdent are line-start whitespace edits on every shape (lists,
//! quotes, paragraphs, code, tables, raw HTML): Indent is always lit and writes
//! one tab per touched line; Outdent is lit exactly when a touched line has
//! leading indentation and removes one level; nothing else changes, and one
//! Undo restores the exact bytes.
use super::*;

/// One line of each block shape the engine reads. (A setext heading's lines are
/// one block, so Indent and Outdent take them together; see below.)
const UNITS: [&str; 22] = [
    "para",
    "# head",
    "> quote",
    "> > deeper",
    "- a",
    "1. a",
    "- [ ] task",
    "  - nested",
    "    - deep",
    "\t- tabbed",
    "  lazy text",
    "```\ncode",
    "~~~\ncode\n~~~",
    "    code",
    "\tcode",
    "| a | b |",
    "| - | - |",
    "<div>",
    "***",
    "- > quoted in item",
    "",
    "   ",
];

fn documents() -> Vec<String> {
    let mut documents = Vec::new();
    let tail = &UNITS[..9];
    for first in UNITS {
        documents.push(first.to_string());
        for second in UNITS {
            documents.push(format!("{first}\n{second}"));
            for third in tail {
                documents.push(format!("{first}\n{second}\n{third}"));
            }
        }
    }
    // Line-ending and end-of-note variants of a mixed note.
    let mixed = "- a\n  - b\n\t> c\n```\n  x\n```\n";
    documents.push(mixed.to_string());
    documents.push(mixed.replace('\n', "\r\n"));
    documents.push(mixed.trim_end().to_string());
    documents
}

/// Display selections: each line's caret, then the whole note.
fn selections(source: &str) -> Vec<(usize, usize)> {
    let display = EditorSession::open(source).display_text();
    let mut selections = Vec::new();
    let mut at = 0;
    for line in display.split('\n') {
        selections.push((at, at));
        selections.push((at, at + line.trim_end_matches('\r').len()));
        at += line.len() + 1;
    }
    selections.push((0, display.len()));
    selections.sort();
    selections.dedup();
    selections
}

/// The note after the command, from the touched lines alone: the lines the
/// selection reaches (not one it only reaches the start of), each given a tab
/// or losing a tab, else up to four spaces.
fn expected(source: &str, from: usize, to: usize, outdent: bool) -> String {
    let line_start = |at: usize| source[..at].rfind('\n').map_or(0, |index| index + 1);
    let (first, last) = (line_start(from), line_start(to));
    // Line starts, including the empty line after a final line ending.
    let mut starts = vec![0];
    starts.extend(source.match_indices('\n').map(|(index, _)| index + 1));
    let mut out = String::new();
    for (index, &at) in starts.iter().enumerate() {
        let end = starts.get(index + 1).copied().unwrap_or(source.len());
        let line = &source[at..end];
        let touched = first <= at && at <= last && !(at == to && from != to && at != first);
        out.push_str(&match line {
            _ if !touched => line.to_owned(),
            _ if !outdent => format!("\t{line}"),
            _ => match line.strip_prefix('\t') {
                Some(rest) => rest.to_owned(),
                None => line[line.bytes().take(4).take_while(|&b| b == b' ').count()..].to_owned(),
            },
        });
    }
    out
}

#[test]
fn indent_is_always_lit_and_outdent_exactly_when_a_touched_line_is_indented() {
    let (mut checked, mut outdented) = (0, 0);
    for source in documents() {
        // A fence's own lines are not text lines, so which lines a selection
        // touches is not a function of its source ends there.
        let fenced = source.contains("```") || source.contains("~~~");
        let lines: Vec<&str> = source.split('\n').collect();
        let line_of = |at: usize| source[..at].matches('\n').count();
        for (a, b) in selections(&source) {
            let mut s = EditorSession::open(&source);
            s.select(s.revision(), range(a, b)).unwrap();
            let state = s.toolbar_state();
            // Text the selection reaches sits on the far side of hidden syntax.
            let source_at = |at, affinity| {
                s.source_at(s.revision(), DisplayOffset(at), affinity)
                    .unwrap()
                    .0
            };
            let from = source_at(a, Affinity::Forward);
            let to = if a == b {
                from
            } else {
                source_at(b, Affinity::Backward).max(from)
            };
            let span = line_of(source_at(a, Affinity::Backward))
                ..=line_of(source_at(b, Affinity::Forward));
            assert!(state.can_indent, "{source:?} {a}..{b}: Indent dimmed");
            for outdent in [false, true] {
                let want = expected(&source, from, to, outdent);
                let lit = if outdent {
                    state.can_outdent
                } else {
                    state.can_indent
                };
                let mut s = EditorSession::open(&source);
                s.select(s.revision(), range(a, b)).unwrap();
                let command = if outdent {
                    BlockCommand::Outdent
                } else {
                    BlockCommand::Indent
                };
                let mut accepted = 0;
                let result = s
                    .block_command(s.revision(), range(a, b), command, &mut |_| {
                        accepted += 1;
                        Ok(())
                    })
                    .unwrap_or_else(|error| panic!("{source:?} {a}..{b} {command:?}: {error:?}"));
                let edited = s.source_text();
                checked += 1;
                // Lit exactly when the command changes something.
                assert_eq!(lit, result.is_some(), "{source:?} {a}..{b} {command:?}");
                assert_eq!(accepted, usize::from(lit));
                assert_eq!(edited != source, lit, "{source:?} {a}..{b} {command:?}");
                if !lit {
                    continue;
                }
                outdented += usize::from(outdent);
                // (a), (b): the touched lines gain one tab or lose one level.
                if !fenced {
                    assert_eq!(edited, want, "{source:?} {a}..{b} {command:?}");
                }
                let after: Vec<&str> = edited.split('\n').collect();
                assert_eq!(after.len(), lines.len(), "{source:?} {a}..{b}");
                for (index, (old, new)) in lines.iter().zip(&after).enumerate() {
                    if old == new {
                        continue;
                    }
                    assert!(span.contains(&index), "{source:?} {a}..{b}: line {index}");
                    let level = if !outdent {
                        new.strip_prefix('\t') == Some(old)
                    } else {
                        let removed = old.len() - new.len();
                        old.ends_with(new)
                            && (removed == 1 && old.starts_with('\t')
                                || (1..=4).contains(&removed)
                                    && old[..removed].bytes().all(|b| b == b' '))
                    };
                    assert!(level, "{source:?} {a}..{b}: {old:?} -> {new:?}");
                }
                // (c) Nothing but leading whitespace changed.
                let bare = |text: &str| -> Vec<String> {
                    text.split('\n')
                        .map(|line| line.trim_start_matches([' ', '\t']).to_owned())
                        .collect()
                };
                assert_eq!(bare(&edited), bare(&source), "{source:?} {a}..{b}");
                // (d) One Undo restores the exact bytes.
                s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
                assert_eq!(s.source_text(), source, "{source:?} {a}..{b} undo");
            }
        }
    }
    assert!(
        checked > 10_000 && outdented > 1_000,
        "{checked} {outdented}"
    );
}

#[test]
fn indent_and_outdent_spell_the_choices_for_lists_fences_and_tables() {
    // (note, command, the displayed text the selection starts before and the
    // text it ends after; "" is the note's start), result.
    for (raw, command, from, to, expected) in [
        // A list item takes a tab and nothing else: no marker, number or
        // blank-line repair, and nothing is refused.
        ("- a\n- b", BlockCommand::Indent, "b", "b", "- a\n\t- b"),
        ("1. a\n2. b", BlockCommand::Indent, "b", "b", "1. a\n\t2. b"),
        ("- a\n- b", BlockCommand::Indent, "a", "a", "\t- a\n- b"),
        (
            "- a\n- b\n- c",
            BlockCommand::Indent,
            "b",
            "c",
            "- a\n\t- b\n\t- c",
        ),
        ("- a\n\t- b", BlockCommand::Outdent, "b", "b", "- a\n- b"),
        ("- a\n   - b", BlockCommand::Outdent, "b", "b", "- a\n- b"),
        (
            "- a\n      - b",
            BlockCommand::Outdent,
            "b",
            "b",
            "- a\n  - b",
        ),
        // Plain text and quotes take the tab at the line start.
        ("para", BlockCommand::Indent, "r", "r", "\tpara"),
        ("> q", BlockCommand::Indent, "q", "q", "\t> q"),
        ("> q", BlockCommand::Outdent, "q", "q", "> q"),
        // A setext heading's lines move together, keeping it a heading.
        ("text\n===", BlockCommand::Indent, "t", "t", "\ttext\n\t==="),
        // Code rows and table rows are literal lines.
        (
            "```\nx\n```",
            BlockCommand::Indent,
            "x",
            "x",
            "```\n\tx\n```",
        ),
        (
            "```\n\tx\n```",
            BlockCommand::Outdent,
            "x",
            "x",
            "```\nx\n```",
        ),
        (
            "| a |\n| - |",
            BlockCommand::Indent,
            "a",
            "a",
            "\t| a |\n| - |",
        ),
        // CRLF stays as it was, and an empty note takes a tab too.
        ("a\r\nb", BlockCommand::Indent, "", "b", "\ta\r\n\tb"),
        ("", BlockCommand::Indent, "", "", "\t"),
    ] {
        let mut s = EditorSession::open(raw);
        let display = s.display_text();
        let at = |marker: &str| display.find(marker).map_or(0, |at| at + marker.len());
        let selection = range(at(from) - from.len(), at(to));
        s.select(s.revision(), selection).unwrap();
        let state = s.toolbar_state();
        let lit = if command == BlockCommand::Indent {
            state.can_indent
        } else {
            state.can_outdent
        };
        let changed = s
            .block_command(s.revision(), selection, command, &mut |_| Ok(()))
            .unwrap()
            .is_some();
        assert_eq!(lit, changed, "{raw:?}");
        assert_eq!(s.source_text(), expected, "{raw:?} {command:?}");
        if changed {
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), raw, "{raw:?} undo");
        }
    }
}

#[test]
fn a_caret_at_the_end_of_a_code_line_leaves_the_closing_fence_alone() {
    let mut s = EditorSession::open("```\nx\n```");
    s.select(s.revision(), range(1, 1)).unwrap();
    s.block_command(s.revision(), range(1, 1), BlockCommand::Indent, &mut |_| {
        Ok(())
    })
    .unwrap()
    .unwrap();
    assert_eq!(s.source_text(), "```\n\tx\n```");
}
