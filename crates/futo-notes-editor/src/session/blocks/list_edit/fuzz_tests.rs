//! Generic list edits on random container shapes: every step equals a fresh
//! open, a refusal changes nothing, and Undo/Redo restore exact bytes.
use crate::{BlockCommand, DisplayOffset, DisplayRange, EditorError, EditorSession, ParagraphKey};

const PIECES: &[&str] = &[
    "- a\n- b\n  - c\n    - d\n  - e\n- f\n",
    "1. one\n2. two\n   1. inner\n3. three\n",
    "5) five\n1) lazy\n\n7. seven\n",
    "- [ ] task\n- [x] done\n  continuation\n",
    "* star\n+ plus\n- dash\n",
    "> - quoted\n>   - nested\n> 2. ordered\n",
    "- a\r\n- b\r\n\r\n- loose\r\n",
    "- item\n\n  para\n\n  ```js\n  code\n  ```\n- next\n",
    "- - same line\n  - sib\n",
    "- > quote in item\n- after\n",
    "# heading\npara one\npara two\n",
    "> plain quote\n> more\n",
    "\n",
    "text **bold\nstill** end\n",
    "<!-- -->\n",
    "9. nine\n\n* x\n* y\n\n7) seven\n",
];
const COMMANDS: &[BlockCommand] = &[
    BlockCommand::BulletList,
    BlockCommand::OrderedList,
    BlockCommand::TaskList,
    BlockCommand::Heading(0),
    BlockCommand::Indent,
    BlockCommand::Outdent,
    BlockCommand::Heading(2),
    BlockCommand::Quote,
    BlockCommand::ToggleTask,
];

/// Non-empty display lines with their formatted runs and links, relative to
/// each line: list commands keep these while changing only block structure.
fn inline_lines(
    s: &EditorSession,
) -> Vec<(
    String,
    Vec<(usize, usize, Vec<crate::InlineFormat>)>,
    Vec<String>,
)> {
    let text = s.display_text();
    let slice = s
        .project(
            s.revision(),
            DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(text.len()),
            },
        )
        .unwrap();
    let mut lines = Vec::new();
    let mut at = 0;
    for line in text.split('\n') {
        let end = at + line.len();
        let body = line.trim_end_matches('\r');
        if !body.is_empty() {
            let mut runs: Vec<(usize, usize, Vec<crate::InlineFormat>)> = Vec::new();
            for run in slice.runs.iter().filter(|run| !run.formats.is_empty()) {
                let (mut a, mut z) = (run.range.start.0.max(at), run.range.end.0.min(end));
                // A block seam may leave edge whitespace outside the markers.
                while a < z && text.as_bytes()[a].is_ascii_whitespace() {
                    a += 1;
                }
                while a < z && text.as_bytes()[z - 1].is_ascii_whitespace() {
                    z -= 1;
                }
                if a >= z {
                    continue;
                }
                match runs.last_mut() {
                    Some(last) if last.1 == a - at && last.2 == run.formats => last.1 = z - at,
                    _ => runs.push((a - at, z - at, run.formats.clone())),
                }
            }
            let links = slice
                .links
                .iter()
                .filter(|link| link.range.start.0 >= at && link.range.end.0 <= end)
                .map(|link| link.destination.clone())
                .collect();
            lines.push((body.to_owned(), runs, links));
        }
        at = end + 1;
    }
    lines
}

#[test]
fn list_edits_match_a_fresh_open_and_undo_exactly() {
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move |bound: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % bound.max(1) as u64) as usize
    };
    let cases = std::env::var("SPLIT_CASES").map_or(60, |cases| cases.parse().unwrap());
    let (mut changed, mut refused) = (0, 0);
    for case in 0..cases {
        let mut original = String::new();
        for _ in 0..1 + next(4) {
            original.push_str(PIECES[next(PIECES.len())]);
        }
        let mut session = EditorSession::open(&original);
        for step in 0..8 {
            let display = session.display_text();
            let point = |next: &mut dyn FnMut(usize) -> usize| {
                let mut at = next(display.len() + 1);
                while !display.is_char_boundary(at) {
                    at -= 1;
                }
                at
            };
            let (a, z) = (point(&mut next), point(&mut next));
            let selected = if next(3) == 0 {
                DisplayRange {
                    start: DisplayOffset(a.min(z)),
                    end: DisplayOffset(a.max(z)),
                }
            } else {
                DisplayRange {
                    start: DisplayOffset(a),
                    end: DisplayOffset(a),
                }
            };
            let before = session.source_text();
            let before_inline = inline_lines(&session);
            super::GENERIC.with(|generic| generic.set(false));
            let revision = session.revision();
            let op = next(COMMANDS.len() + 3);
            let label = format!("case {case} step {step} op {op} {selected:?}\n{before:?}");
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if op < COMMANDS.len() {
                    session.block_command(revision, selected, COMMANDS[op], &mut |_| Ok(()))
                } else if op == COMMANDS.len() {
                    session
                        .replace(
                            revision,
                            selected,
                            ["- ", "1. ", "[ ] "][next(3)],
                            &mut |_| Ok(()),
                        )
                        .map(Some)
                } else {
                    let key = [ParagraphKey::Enter, ParagraphKey::Backspace][next(2)];
                    session.paragraph_key(revision, selected, key, &mut |_| Ok(()))
                }
            }))
            .unwrap_or_else(|_| panic!("panicked: {label}"));
            let fresh = EditorSession::open(&session.source_text());
            assert_eq!(session.display_text(), fresh.display_text(), "{label}");
            let whole = |s: &EditorSession| {
                let end = s.display_text().len();
                let mut slice = s
                    .project(
                        s.revision(),
                        DisplayRange {
                            start: DisplayOffset(0),
                            end: DisplayOffset(end),
                        },
                    )
                    .unwrap();
                slice.revision = crate::Revision(0);
                slice.correspondence.clear();
                slice.links.clear();
                slice
            };
            assert!(whole(&session) == whole(&fresh), "{label}");
            match result {
                Ok(Some(_)) => {
                    let after = session.source_text();
                    if after != before {
                        changed += 1;
                        // Inline runs are kept by every action the generic path plans.
                        let structural = super::GENERIC.with(|generic| generic.get())
                            && op < COMMANDS.len()
                            && COMMANDS[op] != BlockCommand::Heading(2);
                        if structural {
                            let now = inline_lines(&session);
                            assert!(
                                now == before_inline,
                                "inline {label}\n{:?}\n{:?}",
                                before_inline,
                                now
                            );
                        }
                        session.undo(session.revision(), &mut |_| Ok(())).unwrap();
                        assert_eq!(session.source_text(), before, "undo {label}");
                        session.redo(session.revision(), &mut |_| Ok(())).unwrap();
                        assert_eq!(session.source_text(), after, "redo {label}");
                    }
                }
                Ok(None) | Err(EditorError::UnrepresentableFormat) => {
                    refused += usize::from(result.is_err());
                    assert_eq!(session.source_text(), before, "refused {label}");
                }
                Err(_) => assert_eq!(session.source_text(), before, "rejected {label}"),
            }
        }
    }
    // The generator must exercise accepted edits, not only refusals.
    assert!(changed > refused, "changed {changed} refused {refused}");
}
