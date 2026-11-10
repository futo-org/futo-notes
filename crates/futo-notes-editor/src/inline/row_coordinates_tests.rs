use super::super::Projection;
use super::{Row, Segment};

// Frozen first-inclusive-match contract from accepted 6dab1335, before indexing.
// Keep independent of the indexed implementation and its work accounting.
fn historical_linear_display_at(row: &Row, source: usize) -> usize {
    for segment in &row.segments {
        if segment.source.start <= source && source <= segment.source.end {
            if segment.identity {
                return segment.display.start + source - segment.source.start;
            }
            return if source == segment.source.end {
                segment.display.end
            } else {
                segment.display.start
            };
        }
    }
    row.display.len()
}

// Historical inverse keeps the union over every inclusive display match.
fn historical_linear_source_bounds(row: &Row, at: usize) -> (usize, usize) {
    let mut low = row.source_len;
    let mut high = 0;
    for segment in &row.segments {
        if segment.display.start <= at && at <= segment.display.end {
            let (a, b) = if segment.display.is_empty() {
                (segment.source.start, segment.source.end)
            } else if at == segment.display.start {
                (segment.source.start, segment.source.start)
            } else if at == segment.display.end {
                (segment.source.end, segment.source.end)
            } else if segment.identity {
                let position = segment.source.start + at - segment.display.start;
                (position, position)
            } else {
                (segment.source.start, segment.source.end)
            };
            low = low.min(a);
            high = high.max(b);
        }
    }
    if row.segments.is_empty() {
        (0, 0)
    } else {
        (low, high)
    }
}

fn check_canonical_rows(source: &str) -> usize {
    let projection = Projection::new(source);
    let mut checked = 0;
    for index in 0..projection.rows.len() {
        let (row, base, _) = projection.rows.at(index);
        assert!(
            row.segments.windows(2).all(|pair| {
                pair[0].source.end <= pair[1].source.end
                    && pair[0].source.start <= pair[1].source.start
                    && pair[0].display.end <= pair[1].display.end
                    && pair[0].display.start <= pair[1].display.start
                    && pair[0].source.end <= pair[1].source.start
                    && pair[0].display.end <= pair[1].display.start
            }),
            "nonmonotonic canonical segment ends: source_bytes={} row={index}",
            source.len()
        );
        let raw = &source[base..base + row.source_len];
        for at in (0..=raw.len()).filter(|&at| raw.is_char_boundary(at)) {
            assert_eq!(
                row.display_at(at),
                historical_linear_display_at(row, at),
                "coordinate mismatch: source_bytes={} row={index} offset={at}",
                source.len()
            );
            checked += 1;
        }
        for at in (0..=row.display.len()).filter(|&at| row.display.is_char_boundary(at)) {
            assert_eq!(
                row.source_bounds(at),
                historical_linear_source_bounds(row, at),
                "inverse mismatch: source_bytes={} row={index} offset={at}",
                source.len()
            );
            let global =
                historical_global_source_bounds(&projection, at + projection.rows.at(index).2);
            assert_eq!(
                projection.source_bounds(at + projection.rows.at(index).2),
                global
            );
            checked += 1;
        }
    }
    check_source_owner_queries(&projection);
    checked
}

fn check_source_owner_queries(projection: &Projection) {
    let mut ranges = std::collections::BTreeSet::new();
    for index in 0..projection.rows.len() {
        let (row, base, _) = projection.rows.at(index);
        for block in &row.blocks {
            if let Some(list) = &block.list {
                ranges.insert((base + list.item.start, base + list.item.end, false));
                ranges.insert((base + list.owner.start, base + list.owner.end, true));
            }
        }
    }
    for (start, end, owner) in ranges {
        let range = start..end;
        let relevant = |lines: Vec<super::super::blocks::ListCommandLine>| {
            lines
                .into_iter()
                .filter(|line| {
                    !line.code
                        && line.list.as_ref().is_some_and(|list| {
                            if owner {
                                list.first && list.owner == range
                            } else {
                                list.item == range
                            }
                        })
                })
                .map(|line| line.source)
                .collect::<Vec<_>>()
        };
        let old = projection.list_command_lines(crate::DisplayRange {
            start: crate::DisplayOffset(projection.display_at(start)),
            end: crate::DisplayOffset(projection.display_at(end)),
        });
        let bounded = projection.list_command_lines_in_source(&range);
        assert_eq!(
            relevant(bounded),
            relevant(old),
            "canonical source owner query changed: {start}..{end} owner={owner}"
        );
    }
}

fn historical_global_source_bounds(projection: &Projection, at: usize) -> (usize, usize) {
    let (row, source, display) = projection.rows.at(projection.rows.locate(at, true));
    let (low, high) = historical_linear_source_bounds(row, at - display);
    (source + low, source + high)
}

fn check_fixture(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Array(values) => values.iter().map(check_fixture).sum(),
        serde_json::Value::Object(fields) => fields
            .iter()
            .map(|(key, value)| {
                if matches!(key.as_str(), "source" | "expected") {
                    if let Some(source) = value.as_str() {
                        return check_canonical_rows(source);
                    }
                }
                check_fixture(value)
            })
            .sum(),
        _ => 0,
    }
}

#[test]
fn source_coordinate_index_keeps_historical_mapping_at_every_fixture_boundary() {
    let fixtures = [
        include_str!("../../tests/fixtures/list-actions.json"),
        include_str!("../../tests/fixtures/list-shortcuts.json"),
        include_str!("../../tests/fixtures/list-staging.json"),
        include_str!("../../tests/fixtures/nested-containers.json"),
        include_str!("../../tests/fixtures/container-commands.json"),
        include_str!("../../tests/fixtures/structural-seams.json"),
        include_str!("../../tests/fixtures/fence-physical-rows.json"),
    ];
    let checked: usize = fixtures
        .iter()
        .map(|fixture| check_fixture(&serde_json::from_str(fixture).unwrap()))
        .sum();
    assert!(
        checked > 5_000,
        "coordinate fixture coverage silently disappeared: {checked}"
    );
}

#[test]
fn source_coordinate_index_keeps_malformed_entity_reference_and_fence_boundaries() {
    let bodies = [
        "",
        "&acE; &amp; &#x1F600;",
        "**A\u{1f600}** &copy; ` x `",
        "[visible][id]\n\n[id]: /target",
        "![broken",
        "[a](unterminated",
        "~~unclosed",
        "` unmatched",
        "```js\n&acE; *opaque*\n",
        "~~~\r\n\r\n~~~",
        "<pre>\n```\nunknown\n</pre>",
        "\\*literal\\*\r\n\u{85}\u{205f}",
    ];
    for prefix in ["", "- ", "> ", "10. ", "- [x] ", "> - "] {
        for body in bodies {
            check_canonical_rows(&format!("{prefix}{body}"));
            check_canonical_rows(&format!("foreign\n\n{prefix}{body}\n\nfollowing"));
        }
    }
    let projection = Projection::new("&acE;");
    let (row, _, _) = projection.rows.at(0);
    assert_eq!(row.segments[0].source.len(), 5);
    assert_eq!(row.segments[0].display.len(), 5);
    assert!(!row.segments[0].identity);
    for at in 1..5 {
        assert_eq!(row.display_at(at), 0);
    }
    assert_eq!(row.display_at(5), 5);
}

fn model(source_len: usize, display: &str, segments: Vec<Segment>) -> Row {
    Row {
        source_len,
        pipes: false,
        table_scan: crate::table::RowScan::new(&" ".repeat(source_len)),
        parsed_source_bytes: 0,
        guarded_words: Vec::new(),
        images: Vec::new(),
        wikilinks: Vec::new(),
        wikilink_mask: 0,
        wikilink_isolated: Vec::new(),
        typed_inputs: Vec::new(),
        literal_delimiters: Vec::new(),
        literal_links: Vec::new(),
        definitions: Vec::new(),
        reference_uses: Vec::new(),
        reference_work: Default::default(),
        display: display.into(),
        segments,
        spans: Vec::new(),
        blocks: Vec::new(),
        continues: false,
        mid_line: false,
        through: false,
        metadata: false,
        opener: None,
        context: None,
        context_ends: Vec::new(),
        tail_chain: Vec::new(),
    }
}

#[test]
fn source_coordinate_index_keeps_first_inclusive_equal_ends_and_gap_fallback() {
    let cases = [
        (
            model(
                3,
                "0123456789",
                vec![
                    Segment {
                        source: 0..1,
                        display: 0..1,
                        identity: true,
                    },
                    Segment {
                        source: 2..3,
                        display: 9..10,
                        identity: true,
                    },
                ],
            ),
            vec![0, 1, 9, 10],
        ),
        (
            model(
                3,
                "0123456789",
                vec![
                    Segment {
                        source: 1..3,
                        display: 5..7,
                        identity: false,
                    },
                    Segment {
                        source: 3..3,
                        display: 7..10,
                        identity: false,
                    },
                ],
            ),
            vec![10, 5, 5, 7],
        ),
        (
            model(
                1,
                "AAx",
                vec![
                    Segment {
                        source: 0..0,
                        display: 0..2,
                        identity: false,
                    },
                    Segment {
                        source: 0..1,
                        display: 2..3,
                        identity: true,
                    },
                ],
            ),
            vec![2, 3],
        ),
        (
            model(
                3,
                "ab",
                vec![
                    Segment {
                        source: 0..1,
                        display: 0..0,
                        identity: false,
                    },
                    Segment {
                        source: 1..3,
                        display: 0..2,
                        identity: true,
                    },
                ],
            ),
            vec![0, 0, 1, 2],
        ),
    ];
    for (row, expected) in cases {
        assert!(row
            .segments
            .windows(2)
            .all(|pair| pair[0].source.end <= pair[1].source.end));
        for (at, &position) in expected.iter().enumerate() {
            assert_eq!(historical_linear_display_at(&row, at), position);
            assert_eq!(row.display_at(at), position);
        }
        for at in (0..=row.display.len()).filter(|&at| row.display.is_char_boundary(at)) {
            assert_eq!(
                row.source_bounds(at),
                historical_linear_source_bounds(&row, at)
            );
        }
    }
}

#[test]
fn inverse_coordinate_index_keeps_hidden_runs_atom_interiors_and_empty_fallback() {
    let projection = Projection::new("- **&acE;**");
    let (row, _, _) = projection.rows.at(0);
    assert_eq!(row.source_bounds(0), (0, 4));
    assert_eq!(row.source_bounds(3), (4, 9));
    assert_eq!(row.source_bounds(5), (9, 11));
    let hidden = model(
        3,
        "",
        vec![
            Segment {
                source: 0..1,
                display: 0..0,
                identity: false,
            },
            Segment {
                source: 1..3,
                display: 0..0,
                identity: false,
            },
        ],
    );
    assert_eq!(hidden.source_bounds(0), (0, 3));
    assert_eq!(Projection::new("").rows.at(0).0.source_bounds(0), (0, 0));
}
