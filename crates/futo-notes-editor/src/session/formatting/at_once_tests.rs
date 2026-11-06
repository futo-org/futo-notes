//! The one-pass plan must write exactly what the staged sequence writes,
//! whenever it claims a selection at all.
use crate::{DisplayOffset, DisplayRange, EditorSession, InlineFormat};

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
    "see [ref] and [other][ref]\n",
    "[ref]: https://example.com\n",
    "escaped \\*star\\* and &amp; entity\n",
    "<div>\nraw html\n</div>\n",
    "a <https://auto.link> b\n",
    "trailing spaces  \nhard break\n",
    "[[wiki link]] and #tag\n",
    "~~struck~~ and ***both***\n",
    "line\r\nwith crlf\r\n",
];

fn source(s: &EditorSession, range: crate::SourceRange, inserted: &str) -> String {
    let mut text = s.source_text();
    text.replace_range(range.start.0..range.end.0, inserted);
    text
}

#[test]
fn one_pass_plans_write_what_the_staged_sequence_writes() {
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move |bound: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % bound.max(1) as u64) as usize
    };
    let (mut claimed, mut cases) = (0, 0);
    for _ in 0..400 {
        let mut original = String::new();
        if next(8) == 0 {
            original.push_str("---\ntitle: x\n---\n");
        }
        for at in 0..2 + next(5) {
            if at > 0 {
                original.push('\n');
            }
            original.push_str(PIECES[next(PIECES.len())]);
        }
        for format in [
            InlineFormat::Bold,
            InlineFormat::Italic,
            InlineFormat::Strike,
            InlineFormat::Code,
        ] {
            let mut s = EditorSession::open(&original);
            let all = DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(s.display_text().len()),
            };
            s.select(s.revision(), all).unwrap();
            let bodies = s.format_bodies(s.selection);
            if !bodies.multi {
                continue;
            }
            cases += 1;
            let carried: Vec<_> = bodies
                .bodies
                .iter()
                .map(|body| s.carries_format(body.range, format))
                .collect();
            let add = !carried.iter().all(|carried| *carried);
            let Some((range, inserted, _)) =
                s.plan_bodies_at_once(format, add, &bodies.bodies, &carried)
            else {
                continue;
            };
            claimed += 1;
            let (window, _, transaction, _) = s
                .stage_bodies(format, add, &bodies.bodies)
                .unwrap_or_else(|error| panic!("{format:?} {original:?}: {error:?}"));
            let transaction =
                transaction.unwrap_or_else(|| panic!("{format:?} {original:?}: staged refused"));
            let (mut staged_range, staged_inserted) = transaction.finish();
            staged_range.start.0 += window.start;
            staged_range.end.0 += window.start;
            assert_eq!(
                source(&s, range, &inserted),
                source(&s, staged_range, &staged_inserted),
                "{format:?} {original:?}"
            );
        }
    }
    // Lists and table rows share one planning context and stay staged.
    assert!(claimed * 4 > cases, "one pass claimed {claimed} of {cases}");
}
