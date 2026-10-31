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
        include_str!("../../tests/fixtures/structural-seams.json"),
        include_str!("../../tests/fixtures/fence-physical-rows.json"),
    ] {
        let cases: serde_json::Value = serde_json::from_str(fixture).unwrap();
        for case in cases.as_array().unwrap() {
            for key in ["source", "expected"] {
                if let Some(source) = case[key].as_str() {
                    sources.push(source.to_owned());
                }
            }
            if let Some(history) = case["undoSources"].as_array() {
                sources.extend(history.iter().map(|s| s.as_str().unwrap().to_owned()));
            }
        }
    }
    assert!(sources.len() > 400);
    sources
}

#[test]
fn canonical_item_visitor_preserves_every_output_field_and_hidden_prefix() {
    for source in sources() {
        let events = super::super::row::source_events(&source);
        let (old, old_prefixes) = describe_with_items(&source, &events, old_item_lines);
        let (new, new_prefixes) = describe(&source, &events);
        assert_eq!(format!("{new:?}"), format!("{old:?}"), "source={source:?}");
        assert_eq!(new_prefixes, old_prefixes, "source={source:?}");
    }
}

#[test]
fn item_visitor_preserves_empty_and_inclusive_physical_boundary_predicates() {
    for source in sources() {
        let events = super::super::row::source_events(&source);
        let (mut template, _) = describe(&source, &events);
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
        for range in ranges {
            let mut old = template.clone();
            let mut new = template.clone();
            old_item_lines(&mut old, &range);
            mark_item_lines(&mut new, &range);
            assert_eq!(
                format!("{new:?}"),
                format!("{old:?}"),
                "range={range:?} source={source:?}"
            );
        }
    }
}
