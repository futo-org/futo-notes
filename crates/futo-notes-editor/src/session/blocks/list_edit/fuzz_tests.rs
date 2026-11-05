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
type InlineLine = (
    String,
    Vec<(usize, usize, Vec<crate::InlineFormat>)>,
    Vec<String>,
);

fn inline_lines(s: &EditorSession) -> Vec<InlineLine> {
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
            // Inline runs are kept by every block command the generic path plans.
            let inline = super::GENERIC.with(|generic| generic.get())
                && op < COMMANDS.len()
                && COMMANDS[op] != BlockCommand::Heading(2);
            let (accepted, refusal) = check_step(
                &mut session,
                &before,
                inline.then_some(&before_inline),
                result,
                &label,
            );
            changed += usize::from(accepted);
            refused += usize::from(refusal);
        }
    }
    // The generator must exercise accepted edits, not only refusals.
    assert!(changed > refused, "changed {changed} refused {refused}");
}

fn whole(s: &EditorSession) -> crate::ProjectionSlice {
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
}

/// Fresh-open equality, refusal without change, inline preservation and
/// exact Undo/Redo for one step: (accepted a change, refused).
fn check_step(
    session: &mut EditorSession,
    before: &str,
    before_inline: Option<&Vec<InlineLine>>,
    result: Result<Option<crate::ViewChange>, EditorError>,
    label: &str,
) -> (bool, bool) {
    let fresh = EditorSession::open(&session.source_text());
    assert_eq!(session.display_text(), fresh.display_text(), "{label}");
    assert!(whole(session) == whole(&fresh), "{label}");
    match result {
        Ok(Some(_)) => {
            let after = session.source_text();
            if after == before {
                return (false, false);
            }
            if let Some(before_inline) = before_inline {
                untouched_lists_kept(before, &after, label);
                let now = inline_lines(session);
                assert!(
                    now == *before_inline,
                    "inline {label}\n{before_inline:?}\n{now:?}"
                );
            }
            session.undo(session.revision(), &mut |_| Ok(())).unwrap();
            assert_eq!(session.source_text(), before, "undo {label}");
            session.redo(session.revision(), &mut |_| Ok(())).unwrap();
            assert_eq!(session.source_text(), after, "redo {label}");
            (true, false)
        }
        Ok(None) | Err(EditorError::UnrepresentableFormat) => {
            assert_eq!(session.source_text(), before, "refused {label}");
            (false, result.is_err())
        }
        Err(_) => {
            assert_eq!(session.source_text(), before, "rejected {label}");
            (false, false)
        }
    }
}

fn shift_of(before: &str, after: &str) -> isize {
    after.len() as isize - before.len() as isize
}

/// Item start offsets with the index of the list holding each item.
fn list_items(source: &str) -> Vec<(usize, usize)> {
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
    let (mut lists, mut next, mut items) = (Vec::new(), 0, Vec::new());
    for (event, range) in Parser::new_ext(source, Options::ENABLE_TASKLISTS).into_offset_iter() {
        match event {
            Event::Start(Tag::List(_)) => {
                lists.push(next);
                next += 1;
            }
            Event::End(TagEnd::List(_)) => drop(lists.pop()),
            Event::Start(Tag::Item) => items.push((range.start, *lists.last().unwrap())),
            _ => {}
        }
    }
    items
}

/// Items outside the edited span keep their list membership: neighbors on the
/// same side stay together or apart exactly; across the span, separate lists
/// never merge (an edit may only split them).
fn untouched_lists_kept(before: &str, after: &str, label: &str) {
    let prefix = before
        .bytes()
        .zip(after.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    let suffix = before[prefix..]
        .bytes()
        .rev()
        .zip(after[prefix..].bytes().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let (cut, old_end) = (prefix, before.len() - suffix);
    let line_start = |text: &str, at: usize| text[..at].rfind('\n').map_or(0, |at| at + 1);
    // Whole edited lines: a respelled prefix may leave its marker unchanged.
    let line_end = |text: &str, at: usize| text[at..].find('\n').map_or(text.len(), |end| at + end);
    let (cut, old_end) = (line_start(before, cut), line_end(before, old_end.max(cut)));
    let shift = shift_of(before, after);
    let new_items = list_items(after);
    let kept: Vec<(bool, usize, usize)> = list_items(before)
        .into_iter()
        .filter(|&(at, _)| at < cut || at >= old_end)
        .filter_map(|(at, list)| {
            let moved = if at < cut {
                at
            } else {
                at.saturating_add_signed(shift)
            };
            let found = new_items.iter().find(|(start, _)| *start == moved)?;
            Some((at >= old_end, list, found.1))
        })
        .collect();
    for pair in kept.windows(2) {
        let ((side_a, old_a, new_a), (side_b, old_b, new_b)) = (pair[0], pair[1]);
        if side_a == side_b {
            assert_eq!(old_a == old_b, new_a == new_b, "list membership {label}");
        } else if old_a != old_b {
            assert_ne!(new_a, new_b, "lists merged {label}");
        }
    }
}

/// Block markers a typed run may open with, then characters typed after
/// them. Inline delimiters (`*`, `_`, backticks) appear only as markers:
/// their mid-text flanking repairs are a separate inline concern.
const MARKERS: &[&str] = &[
    "", "- ", "* ", "+ ", "1. ", "3. ", "# ", "## ", "> ", "- [ ] ", "[x] ", "*", "  * ", " - ",
    ">", "#", "-", "- - ", "> - ", "- > ", "- ## ",
];
const TYPED: &[u8] = b"#>-+1.[] x aabq";

fn letters_in(text: &str) -> usize {
    text.matches(['a', 'b', 'q']).count()
}

#[test]
fn typed_characters_are_never_refused_and_always_land() {
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = move |bound: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % bound.max(1) as u64) as usize
    };
    let cases = std::env::var("TYPING_CASES").map_or(400, |cases| cases.parse().unwrap());
    for case in 0..cases {
        let mut original = String::new();
        for _ in 0..1 + next(3) {
            original.push_str(PIECES[next(PIECES.len())]);
        }
        let mut session = EditorSession::open(&original);
        // A random line start, or a fresh line after Enter at a line end.
        let display = session.display_text();
        let starts: Vec<usize> = std::iter::once(0)
            .chain(display.match_indices('\n').map(|(at, _)| at + 1))
            .collect();
        let mut at = starts[next(starts.len())];
        let enter = next(2) == 0;
        if enter {
            at = display[at..]
                .find(['\r', '\n'])
                .map_or(display.len(), |end| at + end);
        }
        let caret = DisplayRange {
            start: DisplayOffset(at),
            end: DisplayOffset(at),
        };
        session.select(session.revision(), caret).unwrap();
        if enter {
            let _ =
                session.paragraph_key(session.revision(), caret, ParagraphKey::Enter, &mut |_| {
                    Ok(())
                });
        }
        let mut input = MARKERS[next(MARKERS.len())].to_owned();
        for _ in 0..next(8) {
            input.push(TYPED[next(TYPED.len())] as char);
        }
        let letters = |s: &EditorSession| s.display_text().matches(['a', 'b', 'q']).count();
        // A keyboard may commit the whole run as one string.
        if next(4) == 0 && !input.is_empty() {
            let before = letters(&session);
            let selection = session.selection();
            let label = format!(
                "case {case} committed {input:?} into {original:?}\nnow {:?}",
                session.source_text()
            );
            session
                .replace_action(
                    session.revision(),
                    selection,
                    &input,
                    crate::InputAction::Typing,
                    &mut |_| Ok(()),
                )
                .unwrap_or_else(|error| panic!("{error:?} {label}"));
            let fresh = EditorSession::open(&session.source_text());
            assert_eq!(session.display_text(), fresh.display_text(), "{label}");
            assert_eq!(letters(&session), before + letters_in(&input), "{label}");
            continue;
        }
        for (index, ch) in input.char_indices() {
            let label = format!(
                "case {case} typed {:?} into {original:?}\nnow {:?}",
                &input[..=index],
                session.source_text()
            );
            let before = letters(&session);
            let selection = session.selection();
            session
                .replace_action(
                    session.revision(),
                    selection,
                    &ch.to_string(),
                    crate::InputAction::Typing,
                    &mut |_| Ok(()),
                )
                .unwrap_or_else(|error| panic!("{error:?} {label}"));
            let fresh = EditorSession::open(&session.source_text());
            assert_eq!(session.display_text(), fresh.display_text(), "{label}");
            if matches!(ch, 'a' | 'b' | 'q') {
                assert_eq!(letters(&session), before + 1, "{label}");
            }
        }
    }
}
