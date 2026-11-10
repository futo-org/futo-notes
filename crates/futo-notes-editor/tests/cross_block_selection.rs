//! A selection that crosses a block boundary is replaced or deleted by every
//! input kind (interpretation-and-input.md: a typed character is never
//! refused for its block context), including into or out of a code block and
//! into a list the text before it cannot lazily absorb.
use futo_notes_editor::*;

/// The note the iOS random input suite starts from.
const NOTE: &str = "# Heading one\n\nIntro with **bold**, *italic*, ~~strike~~, `code`, a [link](https://example.com) and [[Other note]].\n\n## Lists\n\n- bullet one\n- bullet two\n\t- nested\n1. first\n2. second\n\n- [ ] task open\n- [x] task done\n\n> a quote\n> second line\n\n```\nlet x = 1\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![img](img.png)\n\nTail paragraph.";

fn range(a: usize, b: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(b),
    }
}

#[derive(Clone, Copy, Debug)]
enum Input {
    Type(&'static str),
    Paste(&'static str),
    Commit(&'static str),
    Enter,
    Backspace,
    Delete,
}

impl Input {
    const ALL: [Input; 6] = [
        Input::Type("d"),
        Input::Paste("pp"),
        Input::Commit("kk"),
        Input::Enter,
        Input::Backspace,
        Input::Delete,
    ];

    fn shown(self) -> &'static str {
        match self {
            Input::Type(text) | Input::Paste(text) | Input::Commit(text) => text,
            Input::Enter => "\n",
            Input::Backspace | Input::Delete => "",
        }
    }
}

fn apply(s: &mut EditorSession, at: DisplayRange, input: Input) -> Result<(), EditorError> {
    s.select(s.revision(), at)?;
    let rev = s.revision();
    let accept = &mut |_: &SourceEdit| Ok(());
    match input {
        Input::Type(text) => s.replace(rev, at, text, accept).map(drop),
        Input::Paste(text) => s.paste_markdown(rev, at, text, accept).map(drop),
        Input::Commit(text) => {
            s.compose(rev, at, text)?;
            s.commit_composition(rev, None, accept).map(drop)
        }
        Input::Enter => s
            .paragraph_key(rev, at, ParagraphKey::Enter, accept)
            .map(drop),
        Input::Backspace => s
            .paragraph_key(rev, at, ParagraphKey::Backspace, accept)
            .map(drop),
        Input::Delete => s
            .paragraph_key(rev, at, ParagraphKey::Delete, accept)
            .map(drop),
    }
}

/// A code block that ends a note hides the note's final line ending. A join
/// into or out of such a block (or one that stops it ending the note) differs
/// from the old display with the range replaced by that ending alone.
fn differs_by_final_ending(note: &str, source: &str, display: &str, expected: &str) -> bool {
    let ends_in_code = |text: &str| {
        let lines: Vec<&str> = text.trim_end_matches(['\r', '\n']).lines().collect();
        let fence = |line: &str| line.starts_with("```") || line.starts_with("~~~");
        lines.iter().filter(|line| fence(line)).count() % 2 == 1
            || lines.last().is_some_and(|line| fence(line))
    };
    let flat = |text: &str| text.trim_end_matches(['\r', '\n']).to_owned();
    (ends_in_code(note) || ends_in_code(source)) && flat(display) == flat(expected)
}

/// Applies `input` over `[a, b)`: it is accepted, the display is the old one
/// with the range replaced, a reopen shows the same, and Undo restores the
/// exact source and selection. Returns the new source.
fn replaced(note: &str, a: usize, b: usize, input: Input) -> String {
    let mut s = EditorSession::open(note);
    let old = s.display_text();
    let label = format!("{input:?} over {:?} of {note:?}", &old[a..b]);
    apply(&mut s, range(a, b), input).unwrap_or_else(|error| panic!("{error:?}: {label}"));
    let source = s.source_text();
    let expected = format!("{}{}{}", &old[..a], input.shown(), &old[b..]);
    let shown = s.display_text();
    if !differs_by_final_ending(note, &source, &shown, &expected) {
        assert_eq!(shown, expected, "{label}\nsource {source:?}");
    }
    assert_eq!(
        EditorSession::open(&source).display_text(),
        shown,
        "{label}\nreopened {source:?}"
    );
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), note, "{label}: Undo");
    assert_eq!(s.selection(), range(a, b), "{label}: Undo selection");
    source
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
fn every_input_replaces_a_selection_from_a_paragraph_into_a_list() {
    // `[69,108)`: from the intro into the second bullet, whose nested item
    // lost its parent and its four columns of indent.
    for input in Input::ALL {
        replaced(NOTE, 69, 108, input);
    }
    let source = replaced(NOTE, 69, 108, Input::Type("d"));
    assert!(
        source.contains("[[Othed\n- nested\n1. first\n2. second\n\n- [ ] task open"),
        "{source:?}"
    );
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
        (
            "```\nlet x = 1\ny = 2\n```\n\ntail",
            4,
            20,
            "```\nlet dl\n```",
        ),
        // From one code block into another.
        (
            "```\nlet x = 1\ny = 2\n```\n\n```\nz = 3\nw = 4\n```\n",
            4,
            22,
            "```\nlet d\n```\n```\nw = 4\n```\n",
        ),
        // From the end of a code line, over the frame's ending.
        ("```\ncode\n```\ntail\n", 4, 5, "```\ncodedtail\n```\n"),
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
        // Into a list: an ordered item starts at 1 under the joined text, and
        // an item indented four columns loses that indent with its parent.
        (
            "para one\n\n1. first\n2. second\n3. third\n\ntail\n",
            4,
            14,
            "paradt\n1. second\n3. third\n\ntail\n",
        ),
        (
            "para one\n\n- bullet a\n\t- nested\n\t- n2\n- bullet b\n",
            4,
            16,
            "parad a\n- nested\n- n2\n- bullet b\n",
        ),
        // A selection that stays inside the line's own list is untouched.
        (
            "1. first\n2. second\n\ntail\n",
            3,
            10,
            "1. firdnd\n\ntail\n",
        ),
    ] {
        let source = replaced(note, a, b, Input::Type("d"));
        assert_eq!(source, expected, "{note:?} [{a},{b})");
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
}

#[test]
fn backspace_at_a_code_blocks_first_line_below_a_blank_line_acts_as_for_a_quote_or_list() {
    // The deletion is the blank line's break; the block's first line joins the line
    // that was blank, as a quote's or a list item's does, and its later lines stay.
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
        let source = replaced(note, at - 1, at, Input::Backspace);
        assert_eq!(source, expected, "{note:?}");
    }
}
