use super::*;

// Frozen literal predicate from the pre-indexed canonical visitor. In
// particular an empty range strictly inside a physical row still matches.
fn old_item_lines(lines: &mut [BlockLine], range: &Range<usize>) {
    for line in lines
        .iter_mut()
        .filter(|line| line.source.start < range.end && range.start < line.source.end)
    {
        line.in_list = true;
    }
}

fn sources() -> Vec<String> {
    let mut sources: Vec<_> = [
        "",
        "-",
        "- ",
        "-\n",
        "-\r\n",
        "- - b",
        "- > - b",
        "- > b",
        "- [x] # b",
        "1000. > b",
        "- a\n  -\n  - b\n- c\n",
        "- a\r\n  - b\r\n- c\r\n",
        "paragraph\n\n- a\n\nnext",
        "-\n\n",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    for fixture in [
        include_str!("../../tests/fixtures/list-actions.json"),
        include_str!("../../tests/fixtures/list-shortcuts.json"),
        include_str!("../../tests/fixtures/list-staging.json"),
        include_str!("../../tests/fixtures/nested-containers.json"),
        include_str!("../../tests/fixtures/container-commands.json"),
        include_str!("../../tests/fixtures/list-header-commands.json"),
        include_str!("../../tests/fixtures/prefix-frame-commands.json"),
        include_str!("../../tests/fixtures/fence-container-commands.json"),
        include_str!("../../tests/fixtures/structural-seams.json"),
        include_str!("../../tests/fixtures/fence-physical-rows.json"),
    ] {
        let cases: serde_json::Value = serde_json::from_str(fixture).unwrap();
        for case in cases.as_array().unwrap() {
            for key in ["source", "expected", "expectedSource"] {
                if let Some(source) = case[key].as_str() {
                    sources.push(source.to_owned());
                }
            }
            if let Some(history) = case["undoSources"].as_array() {
                sources.extend(history.iter().map(|s| s.as_str().unwrap().to_owned()));
            }
        }
    }
    assert_eq!(sources.len(), 574);
    sources
}

#[test]
fn canonical_item_visitor_preserves_every_output_field_and_hidden_prefix() {
    for source in sources() {
        let events = super::super::row::source_events(&source);
        let mut prose = super::super::blocks_paragraph::ProseAttribution::default();
        for (event, span) in &events {
            prose.observe(event, span);
        }
        prose.flush();
        assert!(
            prose.ranges().windows(2).all(|p| p[0].end <= p[1].start),
            "{source:?}"
        );
        let (mut old, old_prefixes) = describe_with_items(&source, &events, old_item_lines);
        let (mut new, new_prefixes) = describe(&source, &events);
        // This fact did not exist in the frozen producer. Independent literal
        // tests prove it; all pre-existing fields remain in this differential.
        for block in old.iter_mut().chain(new.iter_mut()) {
            block.paragraph_text = false;
        }
        assert_eq!(format!("{new:?}"), format!("{old:?}"), "source={source:?}");
        assert_eq!(new_prefixes, old_prefixes, "source={source:?}");
    }
}

#[test]
fn item_visitor_preserves_empty_and_inclusive_physical_boundary_predicates() {
    for source in sources() {
        let events = super::super::row::source_events(&source);
        let (mut template, _) = describe(&source, &events);
        assert!(template
            .iter()
            .all(|line| line.source.start <= line.source.end));
        assert!(template
            .windows(2)
            .all(|pair| pair[0].source.end <= pair[1].source.start));
        for line in &mut template {
            line.in_list = false;
        }
        let mut ranges = vec![0..0, source.len()..source.len(), 0..source.len()];
        for line in &template {
            ranges.extend([
                line.source.start..line.source.start,
                line.source.end..line.source.end,
                line.source.clone(),
            ]);
            if line.source.len() > 1 {
                ranges.push(line.source.start + 1..line.source.start + 1);
            }
        }
        for origin in [0, 61] {
            let mut shifted = template.clone();
            for line in &mut shifted {
                line.shift(origin);
            }
            for range in &ranges {
                let range = range.start + origin..range.end + origin;
                let mut old = shifted.clone();
                let mut new = shifted.clone();
                old_item_lines(&mut old, &range);
                mark_item_lines(&mut new, &range);
                assert_eq!(
                    format!("{new:?}"),
                    format!("{old:?}"),
                    "origin={origin} range={range:?} source={source:?}"
                );
            }
        }
    }
}

#[test]
fn crossquote_tight_item_owns_an_inline_run_without_a_paragraph_event() {
    let raw = "- > - b\n  >   c";
    let events = super::super::row::source_events(raw);
    let items: Vec<_> = events
        .iter()
        .filter_map(|(event, span)| {
            matches!(event, Event::Start(Tag::Item)).then_some(span.clone())
        })
        .collect();
    assert_eq!(items, vec![0..15, 4..15]);
    assert!(!events
        .iter()
        .any(|(event, _)| matches!(event, Event::Start(Tag::Paragraph))));
    let inner = events
        .iter()
        .position(|(event, span)| matches!(event, Event::Start(Tag::Item)) && *span == (4..15))
        .unwrap();
    assert!(
        matches!(&events[inner + 1], (Event::Text(text), span) if text.as_ref() == "b" && *span == (6..7))
    );
    assert!(matches!(&events[inner + 2], (Event::SoftBreak, span) if *span == (7..8)));
    assert!(
        matches!(&events[inner + 3], (Event::Text(text), span) if text.as_ref() == "c" && *span == (14..15))
    );
    assert!(matches!(
        &events[inner + 4],
        (Event::End(pulldown_cmark::TagEnd::Item), _)
    ));
    let projection = super::super::Projection::new(raw);
    let source = ropey::Rope::from_str(raw);
    let (_, _, _, paragraph) = projection.list_items_and_paragraph_at(&source, 4, Some(6));
    // The diagnostic query originally returned None at5f8dfb3e2. The fixed
    // planner now returns these same independently proved inline event bounds.
    assert_eq!(paragraph, Some(6..15));
}

#[test]
fn tight_inline_textblocks_stop_before_child_blocks_and_keep_inline_containers() {
    for raw in [
        "- > - b\n  >   c\n  >   - child",
        "- > - b\n  >   c\n  >   ```\n  >   opaque",
    ] {
        let projection = super::super::Projection::new(raw);
        let source = ropey::Rope::from_str(raw);
        let (items, _, _, paragraph) = projection.list_items_and_paragraph_at(&source, 4, Some(6));
        assert_eq!(paragraph, Some(6..16));
        assert!(items
            .iter()
            .any(|item| item.marker.start == 4 && item.item.end > 16));
    }
    for raw in [
        "- > - *b*\n  >   `c`",
        "- > - [b](dest)\n  >   c",
        "- > - b  \r\n  >   c",
    ] {
        let projection = super::super::Projection::new(raw);
        let source = ropey::Rope::from_str(raw);
        let (_, _, _, paragraph) = projection.list_items_and_paragraph_at(&source, 4, Some(6));
        assert_eq!(paragraph, Some(6..raw.len()));
    }
    for raw in ["- > - ```\n  >   opaque", "- > - > ```\n  >   > opaque"] {
        let projection = super::super::Projection::new(raw);
        let source = ropey::Rope::from_str(raw);
        let (_, _, _, paragraph) = projection.list_items_and_paragraph_at(&source, 4, Some(6));
        assert_eq!(paragraph, None);
    }
}

fn prose_fact(raw: &str, expected: bool) {
    let events = super::super::row::source_events(raw);
    let (blocks, _) = describe(raw, &events);
    assert!(!blocks.is_empty());
    assert!(
        blocks.iter().all(|b| b.paragraph_text == expected),
        "{raw:?}: {blocks:?}"
    );
    for mut shifted in blocks {
        let fact = shifted.paragraph_text;
        shifted.shift(61);
        assert_eq!(shifted.paragraph_text, fact);
    }
}
macro_rules! prose {
    ($name:ident, $raw:expr, $expected:expr) => {
        #[test]
        fn $name() {
            prose_fact($raw, $expected);
        }
    };
}

prose!(real_list_prose, "- before", true);

prose!(tight_crossquote_prose, "- > - before\n  >   c", true);

prose!(task_body_prose, "- [x] before", true);

prose!(inline_code_prose, "- `before`", true);

prose!(inline_html_inside_emphasis_is_prose, "- *<b>*", true);

prose!(link_body_prose, "- [before](dest)", true);

prose!(empty_link_is_still_inline_prose, "- []()", true);

prose!(
    nested_inline_containers_are_prose,
    "- **[before](dest)**\n  c",
    true
);

prose!(parent_and_child_tight_prose, "- before\n  - child", true);

prose!(multiline_inline_code_is_prose, "- `a\n  b`", true);

prose!(heading_is_not_prose, "- # before", false);

prose!(setext_is_not_prose, "- before\n  ---", false);

prose!(fence_is_not_prose, "- ```\n  before\n  ```", false);

prose!(html_block_is_not_prose, "- <script>x</script>", false);

prose!(padded_empty_item_is_not_prose, "-      ", false);

prose!(empty_item_is_not_prose, "- ", false);

prose!(comment_is_not_prose, "- <!-- -->\n", false);

#[test]
fn authored_blank_between_prose_blocks_has_no_prose_fact() {
    let raw = "- before\n\n  continuation";
    let events = super::super::row::source_events(raw);
    let (blocks, _) = describe(raw, &events);
    assert_eq!(
        blocks.iter().map(|b| b.paragraph_text).collect::<Vec<_>>(),
        vec![true, false, true]
    );
}
