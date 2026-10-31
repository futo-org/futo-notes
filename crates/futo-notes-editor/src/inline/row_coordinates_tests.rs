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
    }
    checked
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
        display: display.into(),
        segments,
        spans: Vec::new(),
        blocks: Vec::new(),
        context: Vec::new(),
        transparent_quote: None,
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
    }
}
