//! Random selections across a code block's boundary on random notes, with
//! the checker the integration tests use (`tests/cross_block_selection/`).
use crate::{Affinity, DisplayOffset, DisplayRange, EditorError, EditorSession, ParagraphKey};
use crate::{SourceEdit, SourceOffset};
use pulldown_cmark::{Event, Options, Parser, Tag};

#[path = "../../../tests/cross_block_selection/check.rs"]
mod check;
use check::{checked_as, Input};

/// A fence that owns everything after it.
const OPEN_FENCE: &str = "```\nunclosed\nlines\n";
/// Blocks to select across: code blocks of every frame shape, and the
/// blocks beside them. Tables take selections cell by cell and are left out.
const PIECES: &[&str] = &[
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
    "2. two\n3. three\n",
    "- [ ] task\n- [x] done\n",
    "```\r\ncrlf\r\ncode\r\n```\r\n",
    "- crlf\r\n- item\r\n",
    "    indented\n    code\n",
    "plain text here\n",
];

const INPUTS: [Input; 8] = [
    Input::Type("d"),
    Input::Type("xy"),
    Input::Paste("pp"),
    Input::Commit("kk"),
    Input::Enter,
    Input::Backspace,
    Input::Delete,
    Input::Type(" "),
];

/// Whether the display lines `[a, b)` touches hold a code block's line and
/// a line outside that block (another block's, blank or not code).
fn crosses_code(note: &str, a: usize, b: usize) -> bool {
    let s = EditorSession::open(note);
    let shown = s.display_text();
    let blocks: Vec<_> = Parser::new_ext(note, Options::empty())
        .into_offset_iter()
        .filter_map(|(event, at)| matches!(event, Event::Start(Tag::CodeBlock(_))).then_some(at))
        .collect();
    let end = shown[b..].find('\n').map_or(shown.len(), |at| b + at);
    let mut at = shown[..a].rfind('\n').map_or(0, |at| at + 1);
    let mut owners = std::collections::HashSet::new();
    loop {
        let SourceOffset(source) = s
            .source_at(s.revision(), DisplayOffset(at), Affinity::Forward)
            .unwrap();
        owners.insert(blocks.iter().position(|block| block.contains(&source)));
        match shown[at..].find('\n') {
            Some(line) if at + line < end => at += line + 1,
            _ => break,
        }
    }
    owners.len() > 1 && owners.iter().any(Option::is_some)
}

/// Selections across a code block's boundary, with every input kind (typing,
/// paste, Enter, a committed composition, Backspace, Delete). Each reopens as
/// shown and undoes exactly, or is refused and changes nothing. One planned
/// with a code frame given back (`inline::Repaired`, the edits this change
/// accepts) also shows exactly the old display with the range replaced and
/// keeps every other line's block. Edits the planner accepts without that
/// keep the result they had; their wrong shapes are next-steps 3 ("Edits
/// across a code block the engine already accepted"). Refusals are counted,
/// not failed: refusing is how the engine keeps the other lines. `CROSS_CASES`
/// and `CROSS_SEED` widen it.
#[test]
fn selections_across_a_code_block_boundary_replace_only_the_range_or_are_refused() {
    let mut seed =
        std::env::var("CROSS_SEED").map_or(0x9e37_79b9_7f4a_7c15u64, |seed| seed.parse().unwrap());
    let mut next = move |bound: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % bound.max(1) as u64) as usize
    };
    let cases = std::env::var("CROSS_CASES").map_or(1500, |cases| cases.parse().unwrap());
    let (mut crossed, mut repaired, mut refused) = (0, 0, 0);
    for _ in 0..cases {
        let mut note = String::new();
        for _ in 0..2 + next(3) {
            let piece = PIECES[next(PIECES.len())];
            note.push_str(piece);
            // An open fence owns everything after it.
            if piece == OPEN_FENCE {
                break;
            }
            // Blocks are separated, as authored, or not (a lazy line).
            if next(4) != 0 {
                note.push('\n');
            }
        }
        // Sometimes no final line ending.
        if next(4) == 0 {
            note = note.trim_end_matches(['\r', '\n']).to_owned();
        }
        let display = EditorSession::open(&note).display_text();
        let boundary = |next: &mut dyn FnMut(usize) -> usize| {
            let mut at = next(display.len() + 1);
            // Half the time at a line's start or end.
            if next(2) == 0 {
                let ends: Vec<_> = display.match_indices('\n').map(|(at, _)| at).collect();
                let line = next(ends.len() + 1);
                at = ends.get(line).map_or(display.len(), |end| end + next(2));
            }
            while !display.is_char_boundary(at) {
                at -= 1;
            }
            at
        };
        let (x, y) = (boundary(&mut next), boundary(&mut next));
        let (mut a, mut z) = (x.min(y), x.max(y));
        // An endpoint inside a CRLF widens over the whole break (one that
        // splits it is refused: `a_crlf_code_block_keeps_its_line_endings`).
        if display[..a].ends_with('\r') && display[a..].starts_with('\n') {
            a -= 1;
        }
        if display[..z].ends_with('\r') && display[z..].starts_with('\n') {
            z += 1;
        }
        if !display[a..z].contains('\n') || !crosses_code(&note, a, z) {
            continue;
        }
        let input = INPUTS[next(INPUTS.len())];
        let watch = crate::inline::Repaired::watch();
        crossed += 1;
        match checked_as(&note, a, z, input, &|| watch.seen()) {
            None => refused += 1,
            Some(_) => repaired += usize::from(watch.seen()),
        }
    }
    assert!(
        crossed * 4 >= cases,
        "{crossed} of {cases} cases crossed a code block"
    );
    // The repair is what most crossings take, and refusals stay rare.
    assert!(repaired * 3 >= crossed, "{repaired} of {crossed} repaired");
    assert!(refused * 5 <= crossed, "{refused} of {crossed} refused");
}
