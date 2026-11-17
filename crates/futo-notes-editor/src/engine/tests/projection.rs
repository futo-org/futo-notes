//! Literal cases for what a view draws: each line's reading in display offsets.
use super::{ok, range, select};
use crate::engine::Engine;
use crate::{Affinity, InputAction};

fn projected(source: &str) -> crate::ProjectionSlice {
    let engine = Engine::open(source);
    let end = engine.display_len();
    engine.project(engine.revision(), range(0, end)).unwrap()
}

#[test]
fn list_lines_report_their_own_indent_and_marker_as_typed() {
    let slice =
        projected("3) three\n  - two spaces\n     * five\n\t+ tab\n- [x] done\n  plain\nnot");
    let lists: Vec<_> = slice
        .blocks
        .iter()
        .map(|block| {
            block.list.as_ref().map(|list| {
                (
                    block.range.start.0,
                    list.indent,
                    list.marker.as_str(),
                    list.ordered,
                    list.checked,
                )
            })
        })
        .collect();
    assert_eq!(
        lists,
        [
            Some((0, 0, "3)", true, None)),
            Some((6, 2, "-", false, None)),
            Some((17, 5, "*", false, None)),
            Some((22, 4, "+", false, None)),
            Some((26, 0, "-", false, Some(true))),
            Some((31, 2, "", false, None)),
            None,
        ]
    );
    assert_eq!(slice.text, "three\ntwo spaces\nfive\ntab\ndone\nplain\nnot");
}

#[test]
fn a_projection_describes_each_line_from_its_reading() {
    let slice =
        projected("# Head\n> quote **b**\n```rust\nfn x\n```\n---\n[t](u) [[n]] ![a](p.png)");
    assert_eq!(
        slice.text,
        "Head\nquote b\nfn x\n\u{fffc}\nt [[n]] ![a](p.png)"
    );
    let blocks: Vec<_> = slice
        .blocks
        .iter()
        .map(|b| {
            (
                b.range.start.0..b.range.end.0,
                b.heading,
                b.quote_depth,
                b.code.as_ref().map(|code| code.line_number),
                b.divider,
            )
        })
        .collect();
    assert_eq!(
        blocks,
        [
            (0..4, 1, 0, None, false),
            (5..12, 0, 1, None, false),
            (13..17, 0, 0, Some(1), false),
            (18..21, 0, 0, None, true),
            (22..41, 0, 0, None, false),
        ]
    );
    assert_eq!(slice.code_blocks.len(), 1);
    assert_eq!(slice.code_blocks[0].language.as_deref(), Some("rust"));
    assert_eq!(slice.runs.len(), 1);
    assert_eq!(slice.runs[0].range, range(11, 12));
    assert_eq!(slice.runs[0].formats, [crate::InlineFormat::Bold]);
    assert_eq!(slice.links.len(), 1);
    assert_eq!(
        (slice.links[0].range, slice.links[0].destination.as_str()),
        (range(22, 23), "u")
    );
    assert_eq!(slice.wikilinks[0].range, range(24, 29));
    assert_eq!(slice.wikilinks[0].target, "n");
    let atoms: Vec<_> = slice.atoms.iter().map(|a| (a.kind, a.range)).collect();
    assert_eq!(
        atoms,
        [
            (crate::AtomKind::Divider, range(18, 21)),
            (crate::AtomKind::Image, range(30, 41)),
        ]
    );
    let image = slice.atoms[1].image.as_ref().unwrap();
    assert_eq!(
        (image.alt.as_str(), image.destination.as_str(), image.vault),
        ("a", "p.png", true)
    );
    // Correspondence maps every source byte, in order.
    let mut source = 0;
    for piece in &slice.correspondence {
        assert_eq!(piece.source.start.0, source, "{piece:?}");
        source = piece.source.end.0;
    }
    assert_eq!(
        source,
        Engine::open("# Head\n> quote **b**\n```rust\nfn x\n```\n---\n[t](u) [[n]] ![a](p.png)")
            .source_len()
    );
}

#[test]
fn an_empty_last_line_and_an_empty_code_block_keep_their_blocks() {
    let slice = projected("- a\n- ");
    let last = slice.blocks.last().unwrap();
    assert_eq!(last.range, range(2, 2));
    assert_eq!(last.list.as_ref().unwrap().marker, "-");
    let slice = projected("```js\n```");
    assert_eq!(slice.blocks.len(), 1);
    assert!(slice.blocks[0].code.is_some());
    assert_eq!(slice.code_blocks[0].language.as_deref(), Some("js"));
}

#[test]
fn a_change_projects_every_line_it_read_again() {
    // Opening a fence restyles the lines below it, though their text is unchanged.
    let mut engine = Engine::open("a\nb\nc");
    select(&mut engine, 0, 1, Affinity::Forward);
    let change = engine
        .replace(
            engine.revision(),
            range(0, 1),
            "```",
            InputAction::Typing,
            &mut ok,
        )
        .unwrap()
        .unwrap();
    let view = engine.view(change);
    assert_eq!(engine.display_text(), "b\nc");
    assert_eq!(view.projection.range, range(0, 3));
    assert!(view.projection.blocks.iter().all(|b| b.code.is_some()));
}

#[test]
fn list_levels_normalize_tabs_two_and_four_spaces_without_changing_source() {
    for unit in ["\t", "  ", "    "] {
        let source = format!(
            "- root\n{unit}- child\n{unit}{unit}- leaf\n\n{unit}plain\n{unit}- sibling\n- end"
        );
        let slice = projected(&source);
        let levels: Vec<_> = slice
            .blocks
            .iter()
            .filter_map(|b| b.list.as_ref().map(|l| l.level))
            .collect();
        assert_eq!(levels, [0, 1, 2, 1, 1, 0], "{unit:?}");
        assert_eq!(Engine::open(&source).source_text(), source);
    }
}

#[test]
fn list_levels_reset_at_other_blocks_and_quote_boundaries() {
    for separator in [
        "plain",
        "# heading",
        "---",
        "```\ncode\n```",
        "| h |\n|---|\n| row |",
    ] {
        let source = format!("- root\n  - child\n{separator}\n    - new");
        let levels: Vec<_> = projected(&source)
            .blocks
            .into_iter()
            .filter_map(|b| b.list.map(|l| l.level))
            .collect();
        assert_eq!(levels, [0, 1, 0], "{separator:?}");
    }
    let levels: Vec<_> = projected("- root\n>   - quoted\n\n>     - child\n    - outside")
        .blocks
        .into_iter()
        .filter_map(|b| b.list.map(|l| l.level))
        .collect();
    assert_eq!(levels, [0, 0, 1, 0]);
}

#[test]
fn explicit_quote_blank_resets_list_ancestors_only_when_quote_depth_changes() {
    for (source, expected) in [
        ("- root\n  - child\n>\n    - outside", vec![0, 1, 0]),
        ("> - root\n>   - child\n>>\n>     - new", vec![0, 1, 0]),
        ("> - root\n>   - child\n>\n>     - leaf", vec![0, 1, 2]),
        ("> - root\n>   - child\n \t\n>     - leaf", vec![0, 1, 2]),
    ] {
        let levels: Vec<_> = projected(source)
            .blocks
            .into_iter()
            .filter_map(|block| block.list.map(|list| list.level))
            .collect();
        assert_eq!(levels, expected, "{source:?}");
    }
}

#[test]
fn cached_line_sizes_match_rendered_unicode_and_hidden_frames() {
    for source in [
        "",
        "plain 😀 café\r\nnext",
        "# **😀** _é_\r\n- [x] \\*é",
        "---\r\ntitle: 😀\r\n---\r\nbody",
        "---\n😀\n---",
        "```rust\r\n😀\r\n```",
        "```\n```",
        "```",
        "---",
        "> ---\r\n",
        "| 😀 | é |\n|--|--|\n| **x** | y |",
        "[😀](https://x.y) [[é]] #tag",
    ] {
        let engine = Engine::open(source);
        for entry in engine.store.iter_from(0) {
            let shown = entry.display();
            assert_eq!(entry.size.display, shown.len(), "{source:?}");
            assert_eq!(
                entry.size.display16,
                shown.encode_utf16().count(),
                "{source:?}"
            );
            assert_eq!(entry.size.source16, entry.text.encode_utf16().count());
        }
    }
}

/// Inline code reads as code only, whatever marks surround it: the runs a
/// view draws, the formats at a caret inside it, and those a selection of
/// it has all agree. `code` is the display offset of the code's first
/// character.
#[test]
fn inline_code_reads_as_code_only_inside_any_marks() {
    use crate::InlineFormat::{Bold, Code, Italic, Strike};
    let cases = [
        (
            "**a `b` c**",
            2,
            vec![("a ", vec![Bold]), ("b", vec![Code]), (" c", vec![Bold])],
        ),
        ("**`code`**", 0, vec![("code", vec![Code])]),
        ("*a `b`*", 2, vec![("a ", vec![Italic]), ("b", vec![Code])]),
        (
            "~~`b` c~~",
            0,
            vec![("b", vec![Code]), (" c", vec![Strike])],
        ),
        (
            "***a `b`***",
            2,
            vec![("a ", vec![Bold, Italic]), ("b", vec![Code])],
        ),
        ("~~**`b`**~~", 0, vec![("b", vec![Code])]),
        (
            "[**a `b`**](u)",
            2,
            vec![("a ", vec![Bold]), ("b", vec![Code])],
        ),
        (
            "# **h `c`**",
            2,
            vec![("h ", vec![Bold]), ("c", vec![Code])],
        ),
    ];
    for (source, code, runs) in cases {
        let slice = projected(source);
        let shown: Vec<_> = slice
            .runs
            .iter()
            .map(|run| {
                (
                    &slice.text[run.range.start.0..run.range.end.0],
                    run.formats.clone(),
                )
            })
            .collect();
        assert_eq!(shown, runs, "{source}: runs");
        let mut engine = Engine::open(source);
        select(&mut engine, code + 1, code + 1, Affinity::Backward);
        assert_eq!(engine.active_formats(), [Code], "{source}: caret in code");
        select(&mut engine, code, code + 1, Affinity::Forward);
        assert_eq!(engine.active_formats(), [Code], "{source}: code selected");
    }
}

/// Each code line of `slice` as `number`, `<` first, `>` last and its mark;
/// each code block as `start..end language name xcount`.
fn code_facts(slice: &crate::ProjectionSlice) -> (Vec<String>, Vec<String>) {
    let lines = slice
        .blocks
        .iter()
        .filter_map(|block| block.code.as_ref())
        .map(|code| {
            let mark = match code.mark {
                Some(crate::CodeLineMark::Highlight) => " hl",
                Some(crate::CodeLineMark::Lowlight) => " ll",
                None => "",
            };
            let first = if code.first { "<" } else { "" };
            let last = if code.last { ">" } else { "" };
            format!("{}{first}{last}{mark}", code.line_number)
        })
        .collect();
    let blocks = slice
        .code_blocks
        .iter()
        .map(|block| {
            let words: Vec<&str> = [block.language.as_deref(), block.name.as_deref()]
                .into_iter()
                .flatten()
                .collect();
            let (start, end) = (block.range.start.0, block.range.end.0);
            format!("{start}..{end} {} x{}", words.join(" "), block.line_count)
        })
        .collect();
    (lines, blocks)
}

#[test]
fn code_lines_know_their_block() {
    let cases: &[(&str, &[&str], &[&str])] = &[
        (
            "```js\na\nb\n```\n```js\nc\n```",
            &["1<", "2>", "1<>"],
            &["0..3 js x2", "4..5 js x1"],
        ),
        (
            "```\na\n```\n```\nb\n```",
            &["1<>", "1<>"],
            &["0..1  x1", "2..3  x1"],
        ),
        ("```js\n```", &["1<>"], &["0..0 js x1"]),
        ("```\n\n\n```", &["1<", "2>"], &["0..1  x2"]),
        (
            "```\n```\n```\n```",
            &["1<>", "1<>"],
            &["0..0  x1", "1..1  x1"],
        ),
        ("```py\nx\ny", &["1<", "2>"], &["0..3 py x2"]),
        ("```\nx\n", &["1<", "2>"], &["0..2  x2"]),
        ("a\n```\nb\n```", &["1<>"], &["2..3  x1"]),
        (
            "- item\n  ```js\n  code\n  ```\n- next",
            &["1<>"],
            &["5..11 js x1"],
        ),
        (
            "```go name:api handlers.go hl:1,3 ll:2-3\none\ntwo\nthree\nfour\n```",
            &["1< hl", "2 ll", "3 hl", "4>"],
            &["0..18 go api handlers.go x4"],
        ),
        ("```hl:2 ll:9\na\nb\n```", &["1<", "2> hl"], &["0..3  x2"]),
        ("```hl:1\n```", &["1<> hl"], &["0..0  x1"]),
    ];
    for (source, lines, blocks) in cases {
        let (got_lines, got_blocks) = code_facts(&projected(source));
        assert_eq!(got_lines, *lines, "{source:?}");
        assert_eq!(got_blocks, *blocks, "{source:?}");
    }
}

#[test]
fn a_window_into_a_long_block_reports_the_whole_block() {
    let code: String = (1..=100).map(|i| format!("line {i}\n")).collect();
    let source = format!("intro\n```rust\n{code}```\nafter");
    let mut engine = Engine::open(&source);
    let display = engine.display_text();
    let at = display.find("line 50\n").unwrap();
    let window = |engine: &Engine| {
        let slice = engine
            .project(engine.revision(), range(at, at + 10))
            .unwrap();
        code_facts(&slice)
    };
    let end = display.find("\nafter").unwrap();
    let block = format!("6..{end} rust x100");
    assert_eq!(
        window(&engine),
        (vec!["50".into(), "51".into()], vec![block])
    );
    // A line added above the window renumbers what it shows.
    let line_two = display.find("line 2\n").unwrap();
    select(&mut engine, line_two, line_two, Affinity::Forward);
    let enter = engine.replace(
        engine.revision(),
        range(line_two, line_two),
        "x\n",
        InputAction::Typing,
        &mut ok,
    );
    let change = engine.view(enter.unwrap().unwrap());
    let block = format!("6..{} rust x101", end + 2);
    assert_eq!(
        code_facts(&change.projection).1,
        std::slice::from_ref(&block)
    );
    assert_eq!(
        window(&engine),
        (vec!["50".into(), "51".into()], vec![block])
    );
    let slice = engine
        .project(engine.revision(), range(at + 2, at + 2))
        .unwrap();
    assert_eq!(code_facts(&slice).0, ["51"]);
}

#[test]
fn an_info_string_edit_redraws_the_marks_of_its_whole_block() {
    let mut engine = Engine::open("```js hl:1\na\nb\nc\n```\nafter");
    let digit = engine.source_text().find('1').unwrap();
    let change = engine
        .edit_source(
            engine.revision(),
            crate::SourceRange {
                start: crate::SourceOffset(digit),
                end: crate::SourceOffset(digit + 1),
            },
            "3",
            &mut ok,
        )
        .unwrap()
        .unwrap();
    let change = engine.view(change);
    assert_eq!(
        code_facts(&change.projection),
        (
            vec!["1<".into(), "2".into(), "3> hl".into()],
            vec!["0..5 js x3".into()]
        )
    );
}

#[test]
fn a_line_left_after_a_split_block_is_described_as_its_new_first_line() {
    let mut engine = Engine::open("a\n```\nx\ny\nz\n```\nb");
    let y = engine.display_text().find('y').unwrap();
    select(&mut engine, y, y, Affinity::Forward);
    let change = engine
        .block(
            engine.revision(),
            range(y, y),
            crate::BlockCommand::CodeBlock,
            &mut ok,
        )
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "a\n```\nx\n```\ny\n```\nz\n```\nb");
    let z = engine.display_text().find('z').unwrap();
    assert_eq!(change.projection.range, range(2, z + 1));
    assert_eq!(
        code_facts(&change.projection),
        (
            vec!["1<>".into(), "1<>".into()],
            vec!["2..3  x1".into(), "6..7  x1".into()]
        )
    );
}

#[test]
fn a_block_whose_opening_line_turns_to_code_describes_the_line_after_it() {
    // Inside the pasted `py` fence "```q" does not close it, so the second
    // block's opening line reads as code and `fz` is no longer a first line,
    // though its reading and its carry (inside a `py` fence) are unchanged.
    let mut engine = Engine::open("a\n```\nkq\n```\n```py\nfz\n```");
    let change = engine
        .paste_markdown(engine.revision(), range(0, 3), "```py\nz\n```", &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "```py\nz\n```q\n```py\nfz\n```");
    let fz = engine.display_text().find("fz").unwrap();
    assert_eq!(change.projection.range, range(0, fz + 2));
    assert_eq!(
        code_facts(&change.projection),
        (
            vec!["1<".into(), "2".into(), "3".into(), "4>".into()],
            vec![format!("0..{} py x4", fz + 2)]
        )
    );
}
