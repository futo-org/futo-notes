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
            "para\n\n```\nlet x = 1\ny = 2\nz = 3\n```\n\ntail\n",
            4,
            17,
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
        // At the note's end too: the closing line stays after the joined line.
        (
            "```\nlet x = 1\ny = 2\n```\n\ntail",
            4,
            20,
            "```\nlet dl\n```",
        ),
        // From one code block into another: each keeps its frame.
        (
            "```\nlet x = 1\ny = 2\n```\n\n```\nz = 3\nw = 4\n```\n",
            4,
            22,
            "```\nlet d\n```\n```\nw = 4\n```\n",
        ),
        // From the end of a code line, over the frame's ending.
        ("```\ncode\n```\ntail", 4, 5, "```\ncodedtail\n```"),
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
    // A range starting between a CR and its LF widens over the whole break
    // (interpretation-and-input.md), and Undo selects the widened range.
    let note = "para\r\n\r\n```\r\na\r\nb\r\nc\r\n```\r\n";
    let mut s = EditorSession::open(note);
    apply(&mut s, range(5, 12), Input::Type("d")).unwrap();
    assert_eq!(s.source_text(), "parad\r\n```\r\nc\r\n```\r\n");
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), note);
    assert_eq!(s.selection(), range(4, 12));
}

#[test]
fn backspace_at_a_code_blocks_first_line_below_a_blank_line_acts_as_for_a_quote_or_list() {
    // The deletion is the blank line's break; the block's first line joins the line
    // that was blank, as a quote's or a list item's does, and its later lines stay.
    // A frame that goes leaves the note's final line ending where it was.
    for (note, at, expected) in [
        ("para\n\n```\ncode\n```\n", 6, "para\ncode\n"),
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

/// The MR !634 review's repros (`mrqa-engine-artifacts/mr-634/review.md`),
/// once refused, land: no line outside the selection changes its reading
/// (`checked`). The indented-code (H1) rows went: Linedown has no indented
/// code. The others were refused for a CommonMark reading (a lazy line, a
/// setext underline, a closed block's hidden final line ending, Enter's
/// list rule taking the next item's marker).
#[test]
fn the_mr_634_review_repros_land_and_keep_every_other_line() {
    for (note, a, b, input, expected) in [
        (
            "- a\n- b\n\n```\nc\nd\n```\n",
            4,
            6,
            Input::Enter,
            "- a\n- b\n\n\n```\nd\n```\n",
        ),
        (
            "```\nlet x = 1\ny = 2\n```\n\ntail\n",
            4,
            20,
            Input::Type("d"),
            "```\nlet dl\n```\n",
        ),
        (
            "```\ncode\n```\ntail\n",
            4,
            5,
            Input::Type("d"),
            "```\ncodedtail\n```\n",
        ),
        (
            "para\n\n```\nab\n```\nnext line\n",
            2,
            7,
            Input::Type("d"),
            "padb\nnext line\n",
        ),
        (
            "para\n\n```\nab\n```\n=\n",
            2,
            7,
            Input::Type("d"),
            "padb\n=\n",
        ),
        (
            "para\n\n```\ncode\n```\ntail\n",
            5,
            6,
            Input::Backspace,
            "para\ncode\ntail\n",
        ),
        // M2: the line after the block stays where it is. A code line shows
        // its indent, so `[4,8)` ends after `c` of `c1` (fences.json "#348 3").
        (
            "- item\n  ```\n  c1\n  c2\n  ```\nplain text here\n",
            4,
            8,
            Input::Paste("pp"),
            "- itempp1\n  ```\n  c2\n  ```\nplain text here\n",
        ),
    ] {
        assert_eq!(
            checked(note, a, b, input).as_deref(),
            Some(expected),
            "{input:?} [{a},{b}) of {note:?}"
        );
    }
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
    // After `>` backticks are quote text, not a fence: the pasted line after
    // the first takes the quote's marker (clipboard.md).
    let note = "> ```\n> code one\n> code two\n> ```\n\ntail text\n";
    let mut s = EditorSession::open(note);
    apply(&mut s, range(3, 19), Input::Paste("x\ny")).unwrap();
    assert_eq!(s.source_text(), "> ```x\n> ywo\n> ```\n\ntail text\n");
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
    // W1, in Linedown (a fence after a task marker is task text): a run that
    // reaches from prose into code leaves the kept text before it, and its
    // hidden `_` delimiters, as they were.
    let note = "a _fox_ b\nx\n```\ncode one\n```\n";
    assert_eq!(
        checked(note, 2, 16, Input::Os("fox b\nczo")).as_deref(),
        Some("a _fox_ b\nczone\n")
    );
}

/// (note, selected display text, what the text service shows instead)
const KEPT_PLAIN: &[(&str, &str, &str)] = &[
    // The issue: a fence pasted into a task item, kept words after it.
    (
        "- [ ] \n- [ ] ```\n      code\n      ```\n      Heading one\n\ntail",
        "code    \n    Heading",
        "Heading",
    ),
    (
        "- [ ] \n- [ ] ```\n      code\n      ```\n      Heading one\n\ntail",
        "code",
        "cod",
    ),
    (
        "- [ ] \n- [ ] ```\n      code\n      ```\n      Heading one\n\ntail",
        "Heading one",
        "Heading on",
    ),
    (
        "- [ ] \n- [ ] ```\n      code\n      ```\n      Heading one\n\ntail",
        "code    \n    Heading one",
        "Heading one!",
    ),
    // A fence and kept words, in a paragraph, a list, a quote.
    (
        "```\ncode\n```\nHeading one\n\ntail",
        "code\nHeading one",
        "Heading one!",
    ),
    (
        "```\ncode\n```\nHeading one\n\ntail",
        "code\nHeading",
        "Heading",
    ),
    (
        "```\ncode\n```\nHeading one\n\ntail",
        "code\nHeading one",
        "Heading on",
    ),
    (
        "> ```\n> fenced\n> ```\n> tail words\n\nafter",
        "fenced\ntail",
        "tail",
    ),
    (
        "- ```\n  fenced\n  ```\n  tail words\n\nafter",
        "fenced\ntail",
        "tail",
    ),
    (
        "- ```\n  fenced\n  ```\n  tail words\n\nafter",
        "fenced\ntail words",
        "tail word",
    ),
    (
        "para\n\n```\ncode here\n```\ntail words",
        "code here\ntail",
        "tail",
    ),
    // Hidden markup (backticks, asterisks, a link's brackets) at either
    // edge of a kept stretch.
    ("one `two` three four", "two three", "two thre"),
    ("one `two` three four", "one two", "on two"),
    ("one `two` three four", "three four", "three for"),
    ("one `two`three four", "twothree", "twothre"),
    ("one `two`three four", "twothree", "wothree"),
    ("- item `code` more text\nnext", "code more", "cod more"),
    ("- item `code` more text\nnext", "item code", "iten code"),
    ("> quote `code` more text\n> next", "code more", "code mor"),
    (
        "> quote **bold** more text\n> next",
        "bold more",
        "bold mor",
    ),
    (
        "> quote **bold** more text\n> next",
        "bold more",
        "old more",
    ),
    (
        "- [ ] task `code` more text\n- next",
        "code more",
        "code mor",
    ),
    (
        "- [ ] task `code` more\n- [ ] ```\n      fenced\n      ```\n      tail",
        "more",
        "mor",
    ),
    ("text `a` text `b` text", "a text b", "a text"),
    (
        "see [a link](https://x.y) here",
        "a link here",
        "a lin here",
    ),
    (
        "see *one* two ~~three~~ four",
        "one two three",
        "on two three",
    ),
];

/// A text service's replacement keeps the characters it shares with the
/// selection as they were, or is refused: it never turns kept plain text into
/// inline code or emphasis because hidden markup sits at the edge of a kept
/// stretch (#350). `checked` holds every accepted result to the per-character
/// formatting oracle.
#[test]
fn a_text_service_replacement_never_formats_the_text_it_keeps() {
    let mut failed = Vec::new();
    for (note, selected, text) in KEPT_PLAIN {
        let display = EditorSession::open(note).display_text();
        let Some(a) = display.find(selected) else {
            eprintln!("MISSING {selected:?} not in {display:?} of {note:?}");
            continue;
        };
        let run =
            std::panic::catch_unwind(|| checked(note, a, a + selected.len(), Input::Os(text)));
        if run.is_err() {
            failed.push((note, selected, text));
        }
    }
    assert!(failed.is_empty(), "formatting changed: {failed:#?}");
}

fn replace_os_over(note: &str, selected: &str, text: &str) -> Result<String, EditorError> {
    let mut s = EditorSession::open(note);
    let at = s.display_text().find(selected).unwrap();
    let selection = range(at, at + selected.len());
    s.select(s.revision(), selection).unwrap();
    s.replace_os(s.revision(), selection, text, &[], &mut |_| Ok(()))
        .map(|_| s.source_text())
}

/// A dictated phrase over differently formatted words shares only letters the
/// character diff pairs by chance. It lands, never refused: each run the diff
/// derives is replaced on its own and the hidden marks between them stay
/// (interpretation-and-input.md), so the formats those marks give are
/// whatever the pairing leaves.
#[test]
fn a_dictated_phrase_over_mixed_formatting_lands() {
    for (note, selected, text, typed) in [
        (
            "- **jumps** **lazy**s, coffee ~~world~~ hello",
            "jumps lazys, coffee world",
            "Monday items Monday cant",
            "- **Monday** items ~~Monday cant~~ hello",
        ),
        (
            "fox it's recieve **hello**s **over** *project*",
            "fox it's recieve hellos over project",
            "jumps Monday brown items coffee naïve",
            "jumps Monday brown items coffee **naïve**",
        ),
    ] {
        assert_eq!(
            replace_os_over(note, selected, text).as_deref(),
            Ok(typed),
            "{note:?}"
        );
        let a = EditorSession::open(note)
            .display_text()
            .find(selected)
            .unwrap();
        let text: &'static str = text;
        assert!(checked(note, a, a + selected.len(), Input::Os(text)).is_some());
    }
}

/// A kept bold word or link label after a fence joins the code line as
/// typing joins it, its marks gone (nothing refuses a text service's input).
#[test]
fn a_kept_word_after_a_fence_joins_the_code_line_as_typing_does() {
    for note in [
        "```\ncode\n```\n**Heading** one",
        "```\ncode\n```\n[Heading](u) one",
    ] {
        let joined = replace_os_over(note, "\nHeading", "Heading");
        assert_eq!(
            joined.as_deref(),
            Ok("```\ncodeHeading one\n```"),
            "{note:?}"
        );
        assert!(checked(note, 4, 12, Input::Os("Heading")).is_some());
    }
}
