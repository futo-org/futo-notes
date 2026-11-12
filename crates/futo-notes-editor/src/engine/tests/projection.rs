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
                b.code,
                b.language.clone(),
                b.divider,
            )
        })
        .collect();
    assert_eq!(
        blocks,
        [
            (0..4, 1, 0, false, None, false),
            (5..12, 0, 1, false, None, false),
            (13..17, 0, 0, true, Some("rust".to_owned()), false),
            (18..21, 0, 0, false, None, true),
            (22..41, 0, 0, false, None, false),
        ]
    );
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
    assert!(slice.blocks[0].code);
    assert_eq!(slice.blocks[0].language.as_deref(), Some("js"));
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
    assert!(view.projection.blocks.iter().all(|b| b.code));
}
