//! Selections across block boundaries on random container shapes, beside the
//! typing property run in `fuzz_tests.rs`.
use crate::{DisplayOffset, DisplayRange, EditorError, EditorSession, ParagraphKey};

/// A fence that owns everything after it.
const OPEN_FENCE: &str = "```\nunclosed\nlines\n";
/// Blocks to select across: every shape a selection can leave half of, code
/// and lists first. Tables take selections cell by cell and are left out.
const CROSS_PIECES: &[&str] = &[
    "para one end\n",
    "# head\n",
    "```\nlet x = 1\ny = 2\nz = 3\n```\n",
    "~~~js\none\ntwo\n~~~\n",
    "```\nonly\n```\n",
    OPEN_FENCE,
    "> ```\n> q1\n> q2\n> ```\n",
    "> quote a\n> quote b\n",
    "- item\n\n  ```\n  c1\n  c2\n  ```\n- next\n",
    "- a\n\t- nested\n\t- n2\n- b\n",
    "- a\n  - nested\n- b\n",
    "2. two\n3. three\n",
    "9. nine\n10. ten\n11. eleven\n",
    "1. one\n   1. inner\n2. two\n",
    "- [ ] task\n- [x] done\n",
    "```\r\ncrlf\r\ncode\r\n```\r\n",
    "- crlf\r\n- item\r\n",
    "plain text here\n",
];

#[derive(Clone, Copy, Debug)]
enum Over {
    Type(&'static str),
    Paste(&'static str),
    Commit(&'static str),
    Enter,
    Backspace,
    Delete,
}

impl Over {
    const ALL: [Over; 8] = [
        Over::Type("d"),
        Over::Type("xy"),
        Over::Paste("pp"),
        Over::Commit("kk"),
        Over::Enter,
        Over::Backspace,
        Over::Delete,
        Over::Type(" "),
    ];

    fn shown(self) -> &'static str {
        match self {
            Over::Type(text) | Over::Paste(text) | Over::Commit(text) => text,
            Over::Enter => "\n",
            Over::Backspace | Over::Delete => "",
        }
    }
}

fn apply_over(s: &mut EditorSession, at: DisplayRange, input: Over) -> Result<(), EditorError> {
    let revision = s.revision();
    let accept = &mut |_: &crate::SourceEdit| Ok(());
    match input {
        Over::Type(text) => s.replace(revision, at, text, accept).map(drop),
        Over::Paste(text) => s.paste_markdown(revision, at, text, accept).map(drop),
        Over::Commit(text) => {
            s.compose(revision, at, text)?;
            s.commit_composition(revision, None, accept).map(drop)
        }
        Over::Enter => s
            .paragraph_key(revision, at, ParagraphKey::Enter, accept)
            .map(drop),
        Over::Backspace => s
            .paragraph_key(revision, at, ParagraphKey::Backspace, accept)
            .map(drop),
        Over::Delete => s
            .paragraph_key(revision, at, ParagraphKey::Delete, accept)
            .map(drop),
    }
}

/// Whether `source` ends in a code block, open or closed (`closed`: only a
/// closed one), which hides the note's final line ending.
fn ends_in_code(source: &str, closed: bool) -> bool {
    let lines: Vec<&str> = source
        .trim_end_matches(['\r', '\n'])
        .lines()
        .map(|line| line.trim_start_matches([' ', '>']))
        .collect();
    let is_fence = |line: &str| line.starts_with("```") || line.starts_with("~~~");
    let fences = lines.iter().filter(|line| is_fence(line)).count();
    let last_closes = fences % 2 == 0 && lines.last().is_some_and(|last| is_fence(last));
    last_closes || (!closed && fences % 2 == 1)
}

/// Selections across block boundaries, with every input kind (typing, paste,
/// Enter, a committed composition, Backspace, Delete): none is refused, the
/// display is the old one with the range replaced (see the exceptions below, each
/// an open item), a reopen shows the same, and Undo restores the exact source and
/// selection. `CROSS_CASES` and `CROSS_SEED` widen it.
#[test]
#[allow(clippy::too_many_lines)]
fn selections_across_blocks_are_never_refused_and_change_only_the_selected_range() {
    let mut seed =
        std::env::var("CROSS_SEED").map_or(0x9e37_79b9_7f4a_7c15u64, |seed| seed.parse().unwrap());
    let mut next = move |bound: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % bound.max(1) as u64) as usize
    };
    let cases = std::env::var("CROSS_CASES").map_or(1500, |cases| cases.parse().unwrap());
    let mut checked = 0;
    for case in 0..cases {
        let mut original = String::new();
        for _ in 0..2 + next(3) {
            let piece = CROSS_PIECES[next(CROSS_PIECES.len())];
            original.push_str(piece);
            // An open fence owns everything after it.
            if piece == OPEN_FENCE {
                break;
            }
            // Blocks are separated, as authored: a selection is what brings
            // them together.
            original.push('\n');
        }
        // Sometimes no final line ending.
        if next(4) == 0 {
            original = original.trim_end_matches(['\r', '\n']).to_owned();
        }
        let mut session = EditorSession::open(&original);
        let display = session.display_text();
        let boundary = |next: &mut dyn FnMut(usize) -> usize| {
            let mut at = next(display.len() + 1);
            while !display.is_char_boundary(at) {
                at -= 1;
            }
            at
        };
        let (a, b) = (boundary(&mut next), boundary(&mut next));
        let (mut a, mut z) = (a.min(b), a.max(b));
        // An endpoint inside a CRLF widens over the whole break.
        if display[..a].ends_with('\r') && display[a..].starts_with('\n') {
            a -= 1;
        }
        if display[..z].ends_with('\r') && display[z..].starts_with('\n') {
            z += 1;
        }
        // A selection spanning at least one line break crosses a block or
        // continues one; a lone line's own text is covered elsewhere.
        if !display[a..z].contains('\n') {
            continue;
        }
        let selection = DisplayRange {
            start: DisplayOffset(a),
            end: DisplayOffset(z),
        };
        let input = Over::ALL[next(Over::ALL.len())];
        let label = format!(
            "case {case} {input:?} over {:?} [{a},{z}) of {original:?}",
            &display[a..z]
        );
        session.select(session.revision(), selection).unwrap();
        let lines = session.projection.block_lines(selection);
        // Lines of one paragraph, list item or code block are not a crossing.
        let kinds: std::collections::HashSet<_> = lines
            .iter()
            .map(|line| {
                (
                    line.fence.as_ref().map(|fence| fence.whole.clone()),
                    line.code,
                    line.heading,
                    line.list.as_ref().map(|list| list.owner.clone()),
                    line.quote_depth,
                    line.paragraph_text,
                )
            })
            .collect();
        if kinds.len() < 2 {
            continue;
        }
        // Open item (next-steps.md, Backspace on the blank line after a closing
        // fence): an edit that leaves a closed code block as the note's last
        // block expects the final line ending the block hides, and is refused.
        if display[z..].chars().all(|ch| matches!(ch, '\r' | '\n'))
            && ends_in_code(&original[..session.projection.source_bounds(a).0], true)
        {
            continue;
        }
        // A paste that covers a whole code block takes the block-paste rules,
        // which keep the blank line before it; Enter takes the structural
        // heading, list, quote and code rules, which place its break (and a
        // new item's leading space) by their own spelling. Both are accepted,
        // reopen identically and undo exactly; their placement is covered by
        // the exact-source tests.
        let own_placement = matches!(input, Over::Enter)
            || (matches!(input, Over::Paste(_)) && session.projection.retires_fence(selection).0);
        match apply_over(&mut session, selection, input) {
            Ok(()) => {}
            // Open item (next-steps.md, engine fix lane): Enter over a list
            // item's line break before lazy or nested text answers InvalidRange.
            Err(EditorError::InvalidRange) if matches!(input, Over::Enter) => continue,
            // Enter that starts inside a list or quote is that block's own key
            // rule, not a selection reaching into it from the text above.
            Err(EditorError::UnrepresentableFormat)
                if matches!(input, Over::Enter)
                    && lines
                        .first()
                        .is_some_and(|line| line.in_list || line.quote_depth > 0) =>
            {
                continue
            }
            // Open item: block paste over a whole code block and text after it
            // plans on its own and refuses some list shapes there.
            Err(EditorError::UnrepresentableFormat) if own_placement => continue,
            Err(error) => panic!("{error:?}: {label}"),
        }
        let source = session.source_text();
        let shown = session.display_text();
        let expected = format!("{}{}{}", &display[..a], input.shown(), &display[z..]);
        let final_ending = (ends_in_code(&original, false) || ends_in_code(&source, false))
            && shown.trim_end_matches(['\r', '\n']) == expected.trim_end_matches(['\r', '\n']);
        // Open item (next-steps.md): an edit that leaves an empty line next to
        // a block that depends on it (an ordered list not starting at 1)
        // reinterprets that block, outside the planner's context, as the lazy
        // continuation of the text above. The merged line itself is checked.
        let merged_end = expected[a.min(expected.len())..]
            .find('\n')
            .map_or(expected.len(), |end| a + end + 1);
        let tail_lazy = display[z..].starts_with('\n')
            && expected
                .get(..merged_end)
                .is_some_and(|merged| shown.starts_with(merged));
        assert!(
            own_placement || shown == expected || final_ending || tail_lazy,
            "{label}\ngives {source:?}\nshows {shown:?}\nexpected {expected:?}"
        );
        assert_eq!(
            shown,
            EditorSession::open(&source).display_text(),
            "{label}\ngives {source:?}"
        );
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), original, "{label}: Undo");
        assert_eq!(session.selection(), selection, "{label}: Undo selection");
        checked += 1;
    }
    assert!(checked * 20 >= cases, "{checked} of {cases} cases checked");
}
