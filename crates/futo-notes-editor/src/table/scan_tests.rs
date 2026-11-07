//! Canonical Layout is the independent oracle for the retained scan summary.
use super::{Header, Layout, RowScan, State, Summary};
fn owner(source: &str, at: usize, prefix: Summary) -> Option<Header> {
    if at == source.len() && source.ends_with('\n') {
        return None;
    }
    match prefix.apply(State::Searching(None)) {
        State::Inside(header) => Some(header),
        State::Searching(Some(header))
            if header.start == source[..at].rfind('\n').map_or(0, |at| at + 1) =>
        {
            if prefix.len >= source.len() {
                return None;
            }
            let next = RowScan::new(&source[prefix.len..]).prefix(0).0;
            match prefix.then(next).apply(State::Searching(None)) {
                State::Inside(found) if found == header => Some(found),
                _ => None,
            }
        }
        _ => None,
    }
}
fn expected(source: &str, at: usize) -> Option<Header> {
    let mut spans = Vec::new();
    let mut start = 0;
    for line in source.split_inclusive('\n') {
        spans.push((
            start,
            start + line.len(),
            line.trim_matches([' ', '\t', '\r', '\n']).is_empty(),
        ));
        start += line.len();
    }
    if at == source.len() && source.ends_with('\n') {
        return None;
    }
    let target = spans
        .partition_point(|(_, end, _)| *end <= at)
        .min(spans.len() - 1);
    if spans[target].2 {
        return None;
    }
    let start = spans[..target]
        .iter()
        .rev()
        .find(|(_, _, blank)| *blank)
        .map_or(0, |(_, end, _)| *end);
    let end = spans[target + 1..]
        .iter()
        .find(|(_, _, blank)| *blank)
        .map_or(source.len(), |(start, _, _)| *start);
    Layout::find(&source[start..end], at - start).map(|layout| Header {
        start: start + layout.lines[0].start,
        columns: layout.columns,
    })
}
#[test]
fn retained_scan_matches_greedy_layout_at_every_line_and_across_every_line_seam() {
    let cases = [
        "h|t\n-|-\na|b\n",
        "h|t\n:---|---\nx|y\n-| -\ntail|row\n",
        "h | t\n- | -\na | b\nc | d | e\n- | - | -\nx | y | z",
        "h|t\n-|-\na|b\nc|d|e\n-|-|-\nx|y|z",
        "h|t\n-|-\na|b\n# stop\nu|v\n-|-\nx|y",
        "# bad | head\n- | -\nlater | head\n- | -\nx | y",
        "<div>\nh | t\n- | -\nx | y\n</div>",
        "a|b|c\n-|-\n-|-\nx|y",
        "intro\nItem|Owner\n:---|---\nx|y\n\nplain\n",
        "a\\|b|c\n:---|---\nx|y",
        "a|b\r\n|-|-|\r\nx|y\r\n",
    ];
    for source in cases {
        let facts = RowScan::new(source);
        let mut points = vec![0, source.len()];
        points.extend(
            source
                .match_indices('\n')
                .map(|(at, _)| at + 1)
                .filter(|at| *at < source.len()),
        );
        for &at in &points {
            assert_eq!(
                owner(source, at, facts.prefix(at).0),
                expected(source, at),
                "{source:?} at {at}"
            );
        }
        for &split in &points {
            let joined = RowScan::new(&source[..split])
                .summary
                .then(RowScan::new(&source[split..]).summary);
            for state in [
                State::Searching(None),
                State::Searching(Some(Header {
                    start: 0,
                    columns: 2,
                })),
                State::Searching(Some(Header {
                    start: 0,
                    columns: 3,
                })),
                State::Inside(Header {
                    start: 0,
                    columns: 4,
                }),
            ] {
                assert_eq!(
                    joined.apply(state),
                    facts.summary.apply(state),
                    "{source:?} split {split}"
                );
            }
        }
    }
}
#[test]
fn empty_segments_preserve_external_headers_and_plain_word_fragments_do_not_create_tables() {
    let incoming = State::Searching(Some(Header {
        start: 9,
        columns: 2,
    }));
    assert_eq!(RowScan::new("").summary.apply(incoming), incoming);
    let rule = RowScan::new("-| -\n").summary;
    assert_eq!(
        rule.apply(incoming),
        State::Inside(Header {
            start: 9,
            columns: 2
        })
    );
    let blank = RowScan::new("\n").summary;
    assert_eq!(
        blank.apply(State::Inside(Header {
            start: 0,
            columns: 2
        })),
        State::Searching(None)
    );
    let source = "alpha beta gamma";
    let cut = RowScan::new("alpha be")
        .summary
        .then(RowScan::new("ta gamma").summary);
    assert_eq!(
        cut.apply(incoming),
        RowScan::new(source).summary.apply(incoming)
    );
}
