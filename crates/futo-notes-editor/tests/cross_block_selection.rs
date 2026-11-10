//! A selection that crosses a code block's boundary, into or out of it, is
//! replaced or deleted by every input kind (interpretation-and-input.md), or
//! refused when that would change a line outside it. Accepted, the display is
//! the old one with the range replaced and every other line keeps its block.
use futo_notes_editor::*;

#[path = "cross_block_selection/check.rs"]
mod check;
use check::{apply, checked, range, Input};

/// The note the iOS random input suite starts from.
const NOTE: &str = "# Heading one\n\nIntro with **bold**, *italic*, ~~strike~~, `code`, a [link](https://example.com) and [[Other note]].\n\n## Lists\n\n- bullet one\n- bullet two\n\t- nested\n1. first\n2. second\n\n- [ ] task open\n- [x] task done\n\n> a quote\n> second line\n\n```\nlet x = 1\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![img](img.png)\n\nTail paragraph.";

fn replaced(note: &str, a: usize, b: usize, input: Input) -> String {
    checked(note, a, b, input).unwrap_or_else(|| panic!("refused: {input:?} [{a},{b}) of {note:?}"))
}

#[test]
fn every_input_replaces_a_selection_from_a_paragraph_into_a_code_block() {
    // `[71,176)`: from `note]].` in the intro to `let ` in the code block.
    for input in Input::ALL {
        replaced(NOTE, 71, 176, input);
    }
    let source = replaced(NOTE, 71, 176, Input::Type("d"));
    assert!(source.contains("[[Other dx = 1\n\n| A | B |"), "{source:?}");
}

#[test]
fn text_after_a_selection_joins_the_line_it_began_on_and_code_keeps_its_lines() {
    // (source, display range, source after typing `d`)
    for (note, a, b, expected) in [
        // Into code: the lines left in the block stay code, opened again.
        (
            "para one\n\n```\nlet x = 1\ny = 2\nz = 3\n```\n\ntail\n",
            4,
            21,
            "parad = 2\n```\nz = 3\n```\n\ntail\n",
        ),
        // Into code, one line left: it is text, and the frame goes.
        (
            "para one\n\n```\nlet x = 1\ny = 2\n```\n\ntail\n",
            4,
            21,
            "parad = 2\n\ntail\n",
        ),
        // Out of code: the lines left outside it close the block again.
        (
            "```\nlet x = 1\ny = 2\n```\n\ntail\nmore\n",
            4,
            20,
            "```\nlet dl\n```\nmore\n",
        ),
        // An unclosed block at the note's end already shows that, as before.
        ("```\nlet x = 1\ny = 2\n```\n\ntail", 4, 20, "```\nlet dl"),
        // From one code block into another: they are one now, as before.
        (
            "```\nlet x = 1\ny = 2\n```\n\n```\nz = 3\nw = 4\n```\n",
            4,
            22,
            "```\nlet d\nw = 4\n```\n",
        ),
        // From the end of a code line, over the frame's ending.
        ("```\ncode\n```\ntail", 4, 5, "```\ncodedtail\n```"),
        // Containers keep their prefixes.
        (
            "> ```\n> let x = 1\n> y = 2\n> ```\n\ntail\n",
            4,
            14,
            "> ```\n> let d2\n> ```\n\ntail\n",
        ),
        (
            "tail\n\n> ```\n> let x = 1\n> y = 2\n> z = 3\n> ```\n",
            2,
            12,
            "tad= 1\n> ```\n> y = 2\n> z = 3\n> ```\n",
        ),
    ] {
        assert_eq!(
            replaced(note, a, b, Input::Type("d")),
            expected,
            "{note:?} [{a},{b})"
        );
    }
}

#[test]
fn a_crlf_code_block_keeps_its_line_endings() {
    let note = "para\r\n\r\n```\r\nlet x\r\ny = 2\r\nz = 3\r\n```\r\n\r\ntail\r\n";
    let source = replaced(note, 2, 16, Input::Type("d"));
    assert_eq!(source, "pad = 2\r\n```\r\nz = 3\r\n```\r\n\r\ntail\r\n");
    let note = "```\r\nlet x\r\ny = 2\r\n```\r\n\r\ntail\r\nmore\r\n";
    let source = replaced(note, 2, 16, Input::Type("d"));
    assert_eq!(source, "```\r\nledtail\r\n```\r\nmore\r\n");
    // A range between a CR and its LF is refused, as before: Undo could not
    // select it again as given.
    let note = "para\r\n\r\n```\r\na\r\nb\r\nc\r\n```\r\n";
    assert_eq!(checked(note, 5, 12, Input::Type("d")), None);
}

#[test]
fn backspace_at_a_code_blocks_first_line_below_a_blank_line_acts_as_for_a_quote_or_list() {
    // The deletion is the blank line's break; the block's first line joins the line
    // that was blank, as a quote's or a list item's does, and its later lines stay.
    // A frame that goes takes the note's final line ending, hidden after it, along.
    for (note, at, expected) in [
        ("para\n\n```\ncode\n```\n", 6, "para\ncode"),
        ("para\n\n```\ncode\n```", 6, "para\ncode"),
        (
            "para\n\n```\ncode\nmore\n```\n",
            6,
            "para\ncode\n```\nmore\n```\n",
        ),
        (
            "para\n\n> quote a\n> quote b\n",
            6,
            "para\nquote a\n> quote b\n",
        ),
    ] {
        assert_eq!(
            replaced(note, at - 1, at, Input::Backspace),
            expected,
            "{note:?}"
        );
    }
}

/// The MR !634 review's repros (`mrqa-engine-artifacts/mr-634/review.md`):
/// each is refused as before or gives the right result.
#[test]
fn edits_that_would_change_a_line_outside_the_selection_are_refused() {
    for (note, a, b, input) in [
        // H1: indented code after the joined text would read as prose.
        ("para\n\n    a\n    b\n", 4, 7, Input::Type("d")),
        (
            "## head *two*\n\n    indented code\n    more code\n",
            9,
            10,
            Input::Enter,
        ),
        (
            "# head\n\n    indented code\n    more code\n",
            5,
            8,
            Input::Backspace,
        ),
        // M1: Enter's list rule, after the deletion, takes item `b`'s marker.
        ("- a\n- b\n\n```\nc\nd\n```\n", 4, 6, Input::Enter),
        // A closed block made the note's last one cannot show its final line
        // ending (next-steps 3).
        (
            "```\nlet x = 1\ny = 2\n```\n\ntail\n",
            4,
            20,
            Input::Type("d"),
        ),
        ("```\ncode\n```\ntail\n", 4, 5, Input::Type("d")),
        // R3: the paragraph after a frame that goes would become a lazy line of
        // the joined text, two paragraphs one (next-steps 3).
        ("para\n\n```\nab\n```\nnext line\n", 2, 7, Input::Type("d")),
        ("para\n\n```\nab\n```\n=\n", 2, 7, Input::Type("d")),
        ("para\n\n```\ncode\n```\ntail\n", 5, 6, Input::Backspace),
    ] {
        assert_eq!(
            checked(note, a, b, input),
            None,
            "{input:?} [{a},{b}) of {note:?}"
        );
    }
    // M2: the paragraph after the block stays where it is (as before).
    let note = "- item\n  ```\n  c1\n  c2\n  ```\nplain text here\n";
    assert_eq!(
        checked(note, 4, 8, Input::Paste("pp")).as_deref(),
        Some("- itemppc2\n  ```\nplain text here\n")
    );
}

#[test]
fn a_paste_from_code_out_of_it_lands_as_code_and_the_block_closes_again() {
    // H4: the closer comes back after the text the paste joined, Markdown or not.
    let note = "```\ncode one\ncode two\n```\n\ntail text\n\n# Later heading\n\n- later item\n";
    for paste in [
        "plain",
        "**b**",
        "x\ny",
        "# h",
        "- l1\n- l2",
        "> q",
        "1. one",
    ] {
        let source = checked(note, 3, 19, Input::Paste(paste)).unwrap();
        assert!(
            source.ends_with("tail text\n```\n\n# Later heading\n\n- later item\n"),
            "{paste:?}: {source:?}"
        );
    }
    // Codex P1: a block paste keeps its line on the code line, closed.
    assert_eq!(
        checked("```\nabc\n```\ndef", 1, 5, Input::Paste("- x")).as_deref(),
        Some("```\na- xef\n```")
    );
    // A paste the planner cannot spell that way takes the code block's own
    // rule, as before (its final line ending hides after the code: next-steps 3).
    let note = "> ```\n> code one\n> code two\n> ```\n\ntail text\n";
    let mut s = EditorSession::open(note);
    apply(&mut s, range(3, 19), Input::Paste("x\ny")).unwrap();
    assert_eq!(s.source_text(), "> ```\n> codx\n> ytail text\n");
}

/// iOS types over a selection with `replace_os`, whose text-service runs keep
/// characters the typed text shares with the selection. The runs are checked
/// as the one input they are (re-check R1, R2).
#[test]
fn a_text_service_replacement_is_checked_as_one_input() {
    // R1: a run ending at a code line's end took that line's break. Planned
    // as one run, the code block closes again after the joined text.
    let note = "Some text\n\n```\nlet value = 1\nreturn value\n```\n";
    let source = checked(note, 5, 24, Input::Os("e"));
    assert_eq!(source.as_deref(), Some("Some e\n```\nreturn value\n```\n"));
    let note = "para\n\n```\ndeep\nx\n```\n";
    assert_eq!(
        checked(note, 4, 10, Input::Os("d")).as_deref(),
        Some("parad\n```\nx\n```\n")
    );
    // R2: two explicit runs whose result drops a line break are refused.
    let note = "3) three\n4) four\n\n```\nlet x = 1\ny = 2\nz = 3\n```";
    let mut s = EditorSession::open(note);
    let run = |a, b, text: &str| DisplayReplacement {
        range: range(a, b),
        inserted: text.into(),
    };
    let runs = [run(4, 12, "d"), run(12, 21, "e")];
    assert!(s
        .replace_many(s.revision(), &runs, &mut |_| Ok(()))
        .is_err());
    assert_eq!(s.source_text(), note);
}
