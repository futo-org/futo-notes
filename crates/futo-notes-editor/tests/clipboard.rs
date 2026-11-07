//! Plain Markdown copy, cut and paste through the public session.
use futo_notes_editor::{
    DisplayOffset, DisplayRange, EditorSession, InlineFormat, Revision, SourceEdit,
};
mod common;
use common::ReferenceView;

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

/// Pastes, checks the view delta, Undo/Redo and that replaying the one
/// accepted record on a reopened note reproduces the bytes.
fn paste(source: &str, at: DisplayRange, text: &str) -> EditorSession {
    let mut s = EditorSession::open(source);
    let mut view = ReferenceView::new(&s.display_text());
    let mut records: Vec<SourceEdit> = Vec::new();
    let change = s
        .paste_markdown(s.revision(), at, text, &mut |edit| {
            records.push(edit.clone());
            Ok(())
        })
        .unwrap()
        .unwrap();
    view.apply(change);
    assert_eq!(view.text, s.display_text(), "{source:?} + {text:?}");
    assert_eq!(records.len(), 1);
    let mut reopened = EditorSession::open(source);
    reopened.replay(&records[0]).unwrap();
    assert_eq!(reopened.source_text(), s.source_text());
    assert_eq!(
        EditorSession::open(&s.source_text()).display_text(),
        s.display_text()
    );
    let pasted = s.source_text();
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), source);
    s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), pasted);
    s
}

#[test]
fn paste_keeps_copied_characters_and_places_blocks() {
    // (source, display range, pasted, expected source)
    for (source, (a, b), text, expected) in [
        // Edge spaces, tabs and runs stay; one copied line ending is dropped.
        ("hello", (5, 5), " world", "hello world"),
        ("abcd", (2, 2), "x \n", "abx cd"),
        ("ab", (1, 1), " \tx   y", "a \tx   yb"),
        ("hello", (5, 5), "    world", "hello    world"),
        // A marker alone is its characters; the line stays whole.
        ("abcd", (2, 2), "#", "ab#cd"),
        ("", (0, 0), "-", "&#45;"),
        // A block takes its own line; text either side keeps its block.
        ("abcd", (2, 2), "# Title", "ab\n# Title\ncd"),
        ("## Head", (4, 4), "# Title", "## Head\n# Title"),
        ("## Headtail", (4, 4), "# T", "## Head\n# T\n## tail"),
        ("ab", (2, 2), "x\n# T\ny", "abx\n# T\ny"),
        (
            "abcd",
            (2, 2),
            "1986. A great year",
            "ab\n\n1986. A great year\n\ncd",
        ),
        ("abc\ndef", (4, 4), "2. x", "abc\n\n2. x\n\ndef"),
        ("> abc\n> def", (4, 4), "2. x", "> abc\n>\n> 2. x\n>\n> def"),
        ("abc\n# def", (4, 4), "2. x", "abc\n\n2. x\n\n# def"),
        ("abcd", (2, 2), "```\ncode", "ab\n```\ncode\n```\ncd"),
        // Inside containers: nested under the item, siblings for a list.
        ("- item", (4, 4), "# Title", "- item\n  # Title"),
        ("- item", (4, 4), "- x\n- y", "- item\n- x\n- y"),
        ("- abcd", (2, 2), "- x\n- y", "- ab\n- x\n- y\n- cd"),
        ("> q", (1, 1), "a\n\nb", "> qa\n>\n> b"),
        ("> \nz", (0, 0), "> a\n> b", "> a\n> b\nz"),
        // Pasted endings follow the note; code takes text verbatim.
        ("ab\r\ncd", (1, 1), "# T\nz", "a\r\n# T\r\nzb\r\ncd"),
        ("```\nab\n```", (1, 1), "x\n# y", "```\nax\n# yb\n```"),
        (
            "```\nab\n```",
            (1, 1),
            "x\n```\ny",
            "````\nax\n```\nyb\n````",
        ),
        (
            "```\narchive\n```",
            (0, 7),
            "alpha\n```\nomega\n```",
            "````\nalpha\n```\nomega\n```\n````",
        ),
        (
            "> ```\n> ab\n> ```",
            (1, 1),
            "x\n```\ny",
            "> ````\n> ax\n> ```\n> yb\n> ````",
        ),
        (
            "- ```\n  ab\n  ```",
            (1, 1),
            "x\n```\ny",
            "- ````\n  ax\n  ```\n  yb\n  ````",
        ),
        (
            "~~~\nab\n~~~",
            (1, 1),
            "x\n~~~~\ny",
            "~~~~~\nax\n~~~~\nyb\n~~~~~",
        ),
        ("```\nab", (1, 1), "x\n```\ny", "````\nax\n```\nyb"),
        (
            "```\r\nab\r\n```\r\n",
            (1, 1),
            "x\n```\ny",
            "````\r\nax\r\n```\r\nyb\r\n````\r\n",
        ),
        ("```\ncode\n\n```", (5, 5), "\n\n", "```\ncode\n\n\n```"),
        ("    ab", (1, 1), "x\n```\ny", "    ax\n    ```\n    yb"),
        ("    code", (2, 2), "x\n# y", "    cox\n    # yde"),
        (
            "    co\n    de",
            (2, 2),
            "x\n\ny",
            "    cox\n\n    y\n    de",
        ),
        // A selection is replaced; inline text carries its first format.
        ("a **bold** c", (2, 6), "*it*", "a ***it*** c"),
        ("**abcd**", (1, 3), "# T", "**a**\n# T\n**d**"),
        ("**ab**", (1, 1), "x\n\ny", "**ax**\n\n**yb**"),
        ("[ab](u)", (1, 1), "x\n\ny", "[ax](u)\n\n[yb](u)"),
        ("**ab** c", (1, 1), "# T\n\nz", "**a**\n# T\n\n**zb** c"),
        ("ab", (1, 1), "\n", "a\nb"),
        // A pasted span beside the same style joins it.
        ("x **a** y", (3, 3), "**b**", "x **ab** y"),
        ("x **a** y", (2, 2), "**b**", "x **ba** y"),
        ("x *a* y", (3, 3), "*b*", "x *ab* y"),
        ("**abc**", (2, 2), "__x__", "**abxc**"),
    ] {
        let s = paste(source, range(a, b), text);
        assert_eq!(s.source_text(), expected, "{source:?} + {text:?}");
    }
}

#[test]
fn pasted_soft_lines_keep_their_whitespace() {
    let s = paste("ab", range(1, 1), "x  \n\ty z");
    assert_eq!(s.display_text(), "ax  \n\ty zb");
}

#[test]
fn copy_exports_markdown_for_the_selection() {
    // (source, display range, copied Markdown)
    for (source, (a, b), expected) in [
        ("**bold** text", (1, 7), "**old** te"),
        ("a *it **b** c* d", (3, 6), "*t **b***"),
        ("`co`de", (1, 2), "`o`"),
        ("x [li*nk*](u) y", (5, 8), "[*k*](u) y"),
        ("# Head\nbody", (0, 4), "# Head"),
        ("# Head\nbody", (1, 3), "ea"),
        ("- a\n  - b\n  - c", (2, 5), "- b\n- c"),
        ("> a\r\n> b", (0, 4), "> a\r\n> b"),
        ("a  b", (1, 3), "  "),
        ("**a b**", (1, 2), " "),
        ("`a b`", (1, 2), " "),
    ] {
        let s = EditorSession::open(source);
        assert_eq!(
            s.copy_markdown(s.revision(), range(a, b)).unwrap(),
            expected,
            "{source:?} {a}..{b}"
        );
        assert_eq!(s.source_text(), source);
    }
}

#[test]
fn cut_is_one_action_and_carries_its_style() {
    let mut s = EditorSession::open("a **bold** c");
    let mut view = ReferenceView::new(&s.display_text());
    let mut accepts = 0;
    let (copied, change) = s
        .cut_markdown(s.revision(), range(2, 6), &mut |_| {
            accepts += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(copied, "**bold**");
    assert_eq!(accepts, 1);
    view.apply(change.unwrap());
    assert_eq!(view.text, "a  c");
    assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
    view.apply(
        s.replace(s.revision(), range(2, 2), "x", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "a **x** c");
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "a **bold** c");
    assert_eq!(view.text, s.display_text());
    assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
    assert_eq!(s.revision(), Revision(4));
}

#[test]
fn large_paste_work_does_not_grow_with_the_note() {
    let pasted: String = (0..2000).map(|i| format!("line {i}\n\n")).collect();
    let work = |paragraphs: usize| {
        let source: String = "para\n\n".repeat(paragraphs) + "ab";
        let mut s = EditorSession::open(&source);
        let end = s.display_text().len();
        let change = s
            .paste_markdown(s.revision(), range(end, end), &pasted, &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        change.work.parsed_source_bytes + change.work.materialized_source_bytes
    };
    let (small, large) = (work(10), work(20_000));
    assert!(large <= small + 64, "small {small}, large {large}");
    assert!(small <= pasted.len() * 8, "small {small}");
}
