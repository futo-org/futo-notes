//! Select-all inline toggles over random mixed notes: a refusal changes
//! nothing, block structure and display survive, Undo is exact, and a toggle
//! that added a format everywhere is undone by toggling it again.
use crate::{DisplayOffset, DisplayRange, EditorError, EditorSession, InlineFormat};
use pulldown_cmark::{Event, Options, Parser, Tag};

const PIECES: &[&str] = &[
    "plain paragraph\n",
    "two line\nparagraph **bold** end\n",
    "# Heading *italic*\n",
    "## **Bold heading**\n",
    "- apples\n- pears\n",
    "- **a**\n- b `code`\n",
    "1. one\n2. two [link](https://x.y)\n",
    "- [ ] todo\n- [x] done ~~gone~~\n",
    "- outer\n  - inner\n    - deep\n- back\n",
    "> quoted *text*\n> more\n",
    "> - quoted item\n",
    "```js\nlet a = '**x**';\n```\n",
    "| a | b |\n|---|---|\n| 1 | **2** |\n",
    "text with `inline code` and [a link](u)\n",
    "***\n",
    "**whole bold**\n",
    "*whole italic*\n",
    "- item\n\n  loose para\n",
];

/// Block-level shape: the start tag of every block, in order.
fn structure(source: &str) -> Vec<String> {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS;
    Parser::new_ext(source, options)
        .filter_map(|event| match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph
                | Tag::Heading { .. }
                | Tag::BlockQuote(_)
                | Tag::CodeBlock(_)
                | Tag::HtmlBlock
                | Tag::List(_)
                | Tag::Item
                | Tag::Table(_)
                | Tag::TableHead
                | Tag::TableRow
                | Tag::TableCell
                | Tag::MetadataBlock(_) => Some(format!("{tag:?}")),
                _ => None,
            },
            Event::Rule => Some("Rule".into()),
            Event::TaskListMarker(done) => Some(format!("Task({done})")),
            _ => None,
        })
        .collect()
}

fn select_all(s: &mut EditorSession) -> DisplayRange {
    let all = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(s.display_text().len()),
    };
    s.select(s.revision(), all).unwrap();
    all
}

fn carries(s: &EditorSession, format: InlineFormat) -> bool {
    let all = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(s.display_text().len()),
    };
    s.project(s.revision(), all)
        .unwrap()
        .runs
        .iter()
        .any(|run| run.formats.contains(&format))
}

#[test]
fn select_all_toggles_keep_blocks_and_undo_exactly() {
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = move |bound: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % bound.max(1) as u64) as usize
    };
    let cases = std::env::var("TOGGLE_CASES").map_or(80, |cases| cases.parse().unwrap());
    let (mut changed, mut twice) = (0, 0);
    for _ in 0..cases {
        let mut original = String::new();
        for at in 0..2 + next(4) {
            if at > 0 {
                original.push('\n');
            }
            original.push_str(PIECES[next(PIECES.len())]);
        }
        for format in [
            InlineFormat::Bold,
            InlineFormat::Italic,
            InlineFormat::Strike,
        ] {
            let mut s = EditorSession::open(&original);
            let display = s.display_text();
            let all = select_all(&mut s);
            let fresh = !carries(&s, format);
            match s.toggle_format(s.revision(), format, &mut |_| Ok(())) {
                Err(EditorError::UnrepresentableFormat) => {
                    assert_eq!(s.source_text(), original, "{format:?} refused {original:?}");
                    continue;
                }
                Err(error) => panic!("{format:?} {original:?}: {error:?}"),
                Ok(_) => {}
            }
            let toggled = s.source_text();
            let context = format!("{format:?} {original:?} -> {toggled:?}");
            assert_eq!(s.display_text(), display, "display: {context}");
            assert_eq!(
                EditorSession::open(&toggled).display_text(),
                display,
                "reopened display: {context}"
            );
            assert_eq!(
                structure(&toggled),
                structure(&original),
                "blocks: {context}"
            );
            assert_eq!(s.selection(), all, "selection: {context}");
            if toggled != original {
                changed += 1;
            }
            // Toggling again from a format-free note removes exactly what
            // the first toggle added.
            if fresh && s.toolbar_state().formats.contains(&format) {
                s.toggle_format(s.revision(), format, &mut |_| Ok(()))
                    .unwrap_or_else(|error| panic!("second toggle {context}: {error:?}"));
                assert_eq!(s.source_text(), original, "toggle twice: {context}");
                s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
                assert_eq!(s.source_text(), toggled, "undo second: {context}");
                twice += 1;
            }
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), original, "undo: {context}");
            assert_eq!(s.selection(), all, "undo selection: {context}");
        }
    }
    assert!(changed > cases, "too few toggles applied: {changed}");
    assert!(twice > cases / 2, "too few double toggles: {twice}");
}
