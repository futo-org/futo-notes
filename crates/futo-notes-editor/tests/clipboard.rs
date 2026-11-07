//! Plain Markdown copy, cut and paste through the public session.
use futo_notes_editor::{
    DisplayOffset, DisplayRange, EditorSession, InlineFormat, Revision, SourceEdit,
};
mod common;
#[path = "clipboard/fenced.rs"]
mod fenced;
use common::ReferenceView;

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

/// Pastes, checks the view delta, Undo/Redo and that replaying the one
/// accepted record on a reopened note reproduces the bytes.
fn paste(
    source: &str,
    at: DisplayRange,
    text: &str,
    expected_caret: Option<usize>,
) -> EditorSession {
    let mut s = EditorSession::open(source);
    s.select(Revision(0), at).unwrap();
    let mut view = ReferenceView::new(&s.display_text());
    let mut records: Vec<SourceEdit> = Vec::new();
    let change = s
        .paste_markdown(s.revision(), at, text, &mut |edit| {
            records.push(edit.clone());
            Ok(())
        })
        .unwrap_or_else(|error| panic!("{source:?} + {text:?}: {error:?}"))
        .unwrap();
    if let Some(caret) = expected_caret {
        assert_eq!(change.selection, range(caret, caret), "Paste view caret");
        assert_eq!(s.selection(), range(caret, caret), "Paste session caret");
    }
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
    assert_eq!(s.selection(), at);
    let redone = s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), pasted);
    if let Some(caret) = expected_caret {
        assert_eq!(redone.selection, range(caret, caret), "Redo view caret");
        assert_eq!(s.selection(), range(caret, caret), "Redo session caret");
    }
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
        let s = paste(source, range(a, b), text, None);
        assert_eq!(s.source_text(), expected, "{source:?} + {text:?}");
    }
}

#[test]
fn pasted_soft_lines_keep_their_whitespace() {
    let s = paste("ab", range(1, 1), "x  \n\ty z", None);
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

#[test]
fn copied_named_links_paste_as_markdown_with_their_real_destination() {
    for (original, display, expected, title) in [
        (
            "[alpha](<https://x.test>)",
            "alpha",
            "[alpha](<https://x.test>)",
            None,
        ),
        (
            "[alpha\nbeta](<https://x.test>)\n",
            "alpha\nbeta",
            "[alpha\nbeta](<https://x.test>)",
            None,
        ),
        (
            "[alpha\r\nbeta](<https://x.test>)\r\n",
            "alpha\nbeta",
            "[alpha\nbeta](<https://x.test>)",
            None,
        ),
        (
            "[**alpha**](<https://x.test> 'T')",
            "alpha",
            "[**alpha**](<https://x.test> 'T')",
            Some("T"),
        ),
    ] {
        let source = EditorSession::open(original);
        let copied = source
            .copy_markdown(Revision(0), range(0, source.display_text().len()))
            .unwrap();
        assert_eq!(copied, original);
        let pasted = paste("", range(0, 0), &copied, Some(display.len()));
        assert_eq!(pasted.display_text(), display, "{original:?}");
        assert_eq!(pasted.source_text(), expected);
        let projection = pasted
            .project(pasted.revision(), range(0, display.len()))
            .unwrap();
        assert_eq!(projection.links.len(), 1);
        assert_eq!(projection.links[0].range, range(0, display.len()));
        assert_eq!(projection.links[0].destination, "https://x.test");
        assert_eq!(projection.links[0].title.as_deref(), title);
        if title.is_some() {
            assert!(projection.runs.iter().any(|run| {
                run.range == range(0, display.len()) && run.formats.contains(&InlineFormat::Bold)
            }));
        }
    }
}

#[test]
fn named_link_paste_retains_unicode_neighbors_replaced_styles_and_target_links() {
    for (source, at, text, expected, display, caret) in [
        (
            "猫a tail",
            range(4, 4),
            "[λ](<https://x.test> 'T')",
            "猫a[λ](<https://x.test> 'T') tail",
            "猫aλ tail",
            6,
        ),
        (
            "prefix **old** suffix",
            range(7, 10),
            "[新](<https://x.test>)",
            "prefix **[新](<https://x.test>)** suffix",
            "prefix 新 suffix",
            10,
        ),
        (
            "[abcd](<https://old.test>)",
            range(2, 2),
            "[x](<https://x.test> 'T')",
            "[ab](<https://old.test>)[x](<https://x.test> 'T')[cd](<https://old.test>)",
            "abxcd",
            3,
        ),
        (
            "`ab`",
            range(1, 1),
            "[x](<https://x.test>)",
            "`a[x](<https://x.test>)b`",
            "a[x](<https://x.test>)b",
            1 + "[x](<https://x.test>)".len(),
        ),
    ] {
        let pasted = paste(source, at, text, Some(caret));
        assert_eq!(pasted.source_text(), expected, "{source:?}");
        assert_eq!(pasted.display_text(), display);
        let links = pasted
            .project(pasted.revision(), range(0, display.len()))
            .unwrap()
            .links;
        if source.starts_with('`') {
            assert!(links.is_empty());
        } else {
            assert_eq!(
                links
                    .iter()
                    .filter(|link| link.destination == "https://x.test")
                    .count(),
                1
            );
        }
    }
}

#[test]
fn named_link_paste_keeps_carried_bold_and_opaque_carried_code() {
    for (format, expected, display, linked) in [
        (InlineFormat::Bold, "**[x](<https://x.test>)**", "x", true),
        (
            InlineFormat::Code,
            "`[x](<https://x.test>)`",
            "[x](<https://x.test>)",
            false,
        ),
    ] {
        let mut session = EditorSession::open("");
        session
            .toggle_format(Revision(0), format, &mut |_| {
                panic!("carried format wrote source")
            })
            .unwrap();
        session
            .paste_markdown(
                Revision(0),
                range(0, 0),
                "[x](<https://x.test>)",
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), expected);
        assert_eq!(session.display_text(), display);
        let projection = session
            .project(Revision(1), range(0, display.len()))
            .unwrap();
        assert_eq!(!projection.links.is_empty(), linked);
        assert!(projection
            .runs
            .iter()
            .any(|run| run.formats.contains(&format)));
        session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(session.source_text(), "");
        assert_eq!(session.active_formats(), vec![format]);
    }
}

#[test]
fn cell_link_paste_keeps_pipe_ownership_soft_lines_and_destination_title() {
    let original = "| H | T |\n| - | - |\n| old | keep |\n";
    let start = original.find("old").unwrap();
    for (text, label, expected_cell) in [
        (
            "[p|q\nr](<https://x.test/a|b> 'Title')\n",
            "p|q r",
            "[p\\|q r](<https://x.test/a\\|b> 'Title')",
        ),
        (
            "[`pq`](<https://x.test/a|b> 'Title')",
            "pq",
            "[`pq`](<https://x.test/a\\|b> 'Title')",
        ),
    ] {
        let pasted = paste(
            original,
            range(start, start + 3),
            text,
            Some(start + label.len()),
        );
        assert_eq!(pasted.source_text(), original.replace("old", expected_cell));
        let table = pasted
            .inspect_table(pasted.revision(), range(start, start))
            .unwrap()
            .unwrap();
        assert_eq!(table.columns, 2);
        assert_eq!(table.rows.len(), 2);
        let cell = pasted
            .project(pasted.revision(), table.rows[1][0].content)
            .unwrap();
        assert_eq!(cell.text, label);
        assert_eq!(cell.links.len(), 1);
        assert_eq!(cell.links[0].destination, "https://x.test/a|b");
        assert_eq!(cell.links[0].title.as_deref(), Some("Title"));
    }
}

#[test]
fn named_link_paste_preserves_adjacent_image_and_wikilink_roles() {
    let text = "[x](<https://x.test> 'Link') ![alt](<https://image.test/a.png> 'Image') [[Projects/Roadmap]]";
    let display = "x ![alt](<https://image.test/a.png> 'Image') [[Projects/Roadmap]]";
    let pasted = paste("", range(0, 0), text, Some(display.len()));
    assert_eq!(pasted.source_text(), text);
    assert_eq!(pasted.display_text(), display);
    let projection = pasted
        .project(pasted.revision(), range(0, display.len()))
        .unwrap();
    assert_eq!(projection.links.len(), 1);
    assert_eq!(projection.links[0].range, range(0, 1));
    assert_eq!(projection.links[0].destination, "https://x.test");
    assert_eq!(projection.links[0].title.as_deref(), Some("Link"));
    assert_eq!(projection.atoms.len(), 1);
    let atom = &projection.atoms[0];
    assert_eq!(atom.kind, futo_notes_editor::AtomKind::Image);
    assert_eq!(
        &display[atom.range.start.0..atom.range.end.0],
        "![alt](<https://image.test/a.png> 'Image')"
    );
    let image = atom.image.as_ref().unwrap();
    assert_eq!(image.alt, "alt");
    assert_eq!(image.destination, "https://image.test/a.png");
    assert_eq!(image.title.as_deref(), Some("Image"));
    assert_eq!(projection.wikilinks.len(), 1);
    let wikilink = &projection.wikilinks[0];
    assert_eq!(
        &display[wikilink.range.start.0..wikilink.range.end.0],
        "[[Projects/Roadmap]]"
    );
    assert_eq!(wikilink.target, "Projects/Roadmap");
    assert_eq!(wikilink.label, "Projects/Roadmap");
    assert_eq!(wikilink.note_id, None);
}

#[test]
fn cell_link_paste_refuses_an_unrepresentable_opaque_code_pipe_atomically() {
    let original = "| H | T |\n| - | - |\n| old | keep |\n";
    let start = original.find("old").unwrap();
    let mut session = EditorSession::open(original);
    session
        .select(Revision(0), range(start, start + 3))
        .unwrap();
    let before = session.display_text();
    // The canonical inline parser has no GFM table decoding: escaping a pipe
    // inside Code would add a visible backslash, while leaving it raw creates
    // another cell. Refuse instead of changing either meaning.
    assert!(matches!(
        session.paste_markdown(
            Revision(0),
            range(start, start + 3),
            "[`p|q`](<https://x.test>)",
            &mut |_| panic!("refused paste was accepted")
        ),
        Err(futo_notes_editor::EditorError::UnrepresentableFormat)
    ));
    assert_eq!(session.source_text(), original);
    assert_eq!(session.display_text(), before);
    assert_eq!(session.selection(), range(start, start + 3));
    assert_eq!(session.revision(), Revision(0));
    assert!(session
        .undo(Revision(0), &mut |_| Ok(()))
        .unwrap()
        .is_none());
}
