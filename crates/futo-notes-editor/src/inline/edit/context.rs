//! Canonical source pieces and spans for one input context.
mod bounds;
use super::span_sweep::{Enclosing, MarkerRanges};
use super::*;

impl Projection {
    pub(in crate::inline) fn edit_context(
        &self,
        source: &Rope,
        range: DisplayRange,
    ) -> Result<Context, crate::EditorError> {
        self.edit_context_for_change(source, range, None, super::Width::Rows)
    }

    pub(super) fn edit_context_for_change(
        &self,
        source: &Rope,
        range: DisplayRange,
        replacement: Option<&str>,
        width: super::Width,
    ) -> Result<Context, crate::EditorError> {
        let mut first = self.rows.locate(range.start.0, true);
        let mut last = self.rows.locate(range.end.0, true);
        match width {
            super::Width::Rows => {}
            super::Width::Joined => last += 1,
            super::Width::Line => (first, last) = self.whole_lines(first, last),
            super::Width::Paragraph => (first, last) = self.uncut_piece(source, first, last),
        }
        let (_, source_start, display_start) = self.rows.at(first);
        let (end_row, source_end, _) = self.rows.at(last);
        let source_end = source_end + end_row.source_len;
        let raw = source.byte_slice(source_start..source_end).to_string();
        let mut markers = Vec::new();
        let mut guarded_words = Vec::new();
        let mut typed_inputs = Vec::new();
        let mut link_metadata_items = 0;
        let mut pieces = Vec::<Piece>::new();
        let mut a = range.start.0 - display_start;
        let mut z = range.end.0 - display_start;
        let mut display_len = 0;
        let mut block_boundaries = Vec::new();
        let mut pending_links = Vec::new();
        // Only the two angle word readers need prefix eligibility. Formatting,
        // body rendering and ordinary non-triggering inputs keep the empty path.
        let needs_word_prefixes = replacement.is_some_and(|text| {
            text == ">" || text.chars().next().is_some_and(char::is_whitespace)
        });
        let may_empty_heading = replacement.is_some_and(|text| {
            text.split('\n')
                .any(|line| line.trim_matches([' ', '\t', '\r']).is_empty())
        });
        let mut selected_body_before = false;
        for index in first..=last {
            let (row, row_source, _) = self.rows.at(index);
            let base = row_source - source_start;
            link_metadata_items += super::super::guarded_words::validate_row(
                &raw[base..base + row.source_len],
                row,
                &row.guarded_words,
            )?;
            link_metadata_items +=
                super::super::typed_angle::validate_row(row.source_len, row, &row.typed_inputs)?;
            for origin in &row.typed_inputs {
                let mut origin = origin.clone();
                link_metadata_items += 5 + origin.relocate(base);
                typed_inputs.push(origin);
            }
            for word in &row.guarded_words {
                let mut word = word.clone();
                link_metadata_items += 5 + word.relocate(base);
                guarded_words.push(word);
            }
            let prefixes = super::prefixes::PhysicalPrefixes::read(
                row,
                needs_word_prefixes,
                &mut link_metadata_items,
            );
            let span_base = markers.len();
            pending_links.extend(row.literal_links.iter().map(|range| {
                link_metadata_items += 3;
                base + range.start..base + range.end
            }));
            for pair in row.blocks.windows(2) {
                if pair[0].heading > 0
                    || pair[1].heading > 0
                    || pair[0].quote_depth != pair[1].quote_depth
                {
                    block_boundaries.push(display_len + row.display_at(pair[1].source.start));
                }
            }
            // Literal (pending) link fields, looked up per span rather than
            // scanned per span: a row of many links costs spans + fields.
            let literal: std::collections::HashSet<(usize, usize)> = row
                .literal_links
                .iter()
                .map(|range| (range.start, range.end))
                .collect();
            let suppressed: Vec<bool> = row
                .spans
                .iter()
                .map(|span| {
                    matches!(span.kind, SpanKind::Link(_))
                        && literal.contains(&(span.open.end, span.close.start))
                })
                .collect();
            markers.extend(
                row.spans
                    .iter()
                    .zip(&suppressed)
                    .map(|(span, &suppressed)| {
                        if matches!(span.kind, SpanKind::Link(_)) {
                            link_metadata_items += 1;
                        }
                        let pending = !span.open.is_empty() && suppressed;
                        if matches!(span.kind, SpanKind::Link(_))
                            && !span.open.is_empty()
                            && !literal.is_empty()
                        {
                            link_metadata_items += 1;
                        }
                        if pending {
                            link_metadata_items += 4;
                        }
                        Marker {
                            source: pending.then(|| {
                                (
                                    base + span.open.start..base + span.open.end,
                                    base + span.close.start..base + span.close.end,
                                )
                            }),
                            literal_url: false,
                            pending,
                            activate: false,
                            kind: span.kind.clone(),
                            open: raw[base + span.open.start..base + span.open.end].into(),
                            close: raw[base + span.close.start..base + span.close.end].into(),
                        }
                    }),
            );
            let retired_headings: Vec<_> = row
                .blocks
                .iter()
                .filter(|block| {
                    let body_start = self.display_at(row_source + block.content.start);
                    let body_end = self.display_at(row_source + block.content.end);
                    // Replacing body text across blocks owns a complete lower
                    // heading's dependent syntax. Selecting only its preceding
                    // separator does not grant that same body ownership.
                    let retire = replacement.is_some()
                        && (may_empty_heading || selected_body_before)
                        && block.underline.is_some()
                        && range.start.0 <= body_start
                        && body_end <= range.end.0;
                    selected_body_before |= body_start < body_end
                        && range.start.0 < body_end
                        && body_start < range.end.0;
                    retire
                })
                .collect();
            link_metadata_items += row.definitions.len();
            let hidden: Vec<_> = row
                .definitions
                .iter()
                .filter(|definition| {
                    if !definition.winner {
                        return false;
                    }
                    let (start, a) = row.display_at_with_work(definition.range.start);
                    let (end, z) = row.display_at_with_work(definition.range.end);
                    link_metadata_items += a + z;
                    start == end
                })
                .map(|definition| {
                    (
                        super::super::references::hidden_definition(
                            &raw[base..base + row.source_len],
                            definition,
                        ),
                        definition.witness.as_ref().unwrap().clone(),
                    )
                })
                .collect();
            let mut hidden = hidden.iter().peekable();
            let mut enclosing = Enclosing::new(row, |index| {
                !suppressed[index] || !row.spans[index].open.is_empty()
            });
            let markers_at = MarkerRanges::new(row);
            for segment in &row.segments {
                while hidden
                    .peek()
                    .is_some_and(|(range, _)| range.end <= segment.source.start)
                {
                    hidden.next();
                }
                if let Some((range, key)) = hidden.peek().filter(|(range, _)| {
                    range.start <= segment.source.start && segment.source.end <= range.end
                }) {
                    link_metadata_items += 1;
                    if segment.source.start == range.start {
                        pieces.push(Piece {
                            guard: None,
                            physical_prefix: false,
                            literal_url: None,
                            raw: raw[base + range.start..base + range.end].into(),
                            display: String::new(),
                            spans: Vec::new(),
                            trailing: true,
                            definition: Some(key.clone()),
                            origin: Some(PieceOrigin::Source(base + range.start..base + range.end)),
                            timing: false,
                        });
                    }
                    continue;
                }
                for block in &retired_headings {
                    if segment.source.start == block.source.start {
                        // Setext syntax depends on nonempty body text. Preserve
                        // the heading/container intent using the existing empty
                        // ATX form, retiring only the owned underline below.
                        pieces.push(Piece {
                            guard: None,
                            physical_prefix: false,
                            literal_url: None,
                            raw: format!(
                                "{}{} ",
                                &raw[base + block.source.start..base + block.content.start],
                                "#".repeat(block.heading as usize)
                            ),
                            display: String::new(),
                            spans: Vec::new(),
                            trailing: false,
                            definition: None,
                            origin: None,
                            timing: false,
                        });
                    }
                }
                if retired_headings.iter().any(|block| {
                    segment.display.is_empty()
                        && (segment.source.end <= block.content.start
                            && block.source.start <= segment.source.start
                            || block.content.end <= segment.source.start
                                && segment.source.end
                                    <= block.underline.as_ref().unwrap().content.end)
                }) {
                    continue;
                }
                let active = enclosing
                    .at(&segment.source, &mut link_metadata_items)
                    .into_iter()
                    .map(|i| span_base + i)
                    .collect();
                if segment.display.is_empty() {
                    // Inline markers are reconstructed from spans; block markers
                    // are exact source pieces outside that inline stack.
                    if markers_at.covers(&segment.source, &mut link_metadata_items) {
                        continue;
                    }
                    let trailing =
                        super::super::blocks::trailing_syntax(&row.blocks, &segment.source);
                    pieces.push(Piece {
                        guard: None,
                        physical_prefix: prefixes
                            .contains(&segment.source, &mut link_metadata_items),
                        literal_url: None,
                        raw: raw[base + segment.source.start..base + segment.source.end].to_owned(),
                        display: String::new(),
                        spans: active,
                        trailing,
                        definition: None,
                        origin: Some(PieceOrigin::Source(
                            base + segment.source.start..base + segment.source.end,
                        )),
                        timing: false,
                    });
                    continue;
                }
                pieces.push(Piece {
                    guard: None,
                    physical_prefix: false,
                    literal_url: None,
                    raw: raw[base + segment.source.start..base + segment.source.end].to_owned(),
                    display: row.display[segment.display.clone()].to_owned(),
                    spans: active,
                    trailing: false,
                    definition: None,
                    origin: Some(PieceOrigin::Source(
                        base + segment.source.start..base + segment.source.end,
                    )),
                    timing: row
                        .literal_delimiters
                        .binary_search_by_key(
                            &(segment.source.start, segment.source.end),
                            |range| {
                                link_metadata_items += 1;
                                (range.start, range.end)
                            },
                        )
                        .is_ok(),
                });
            }
            display_len += row.display.len();
        }
        a = a.min(display_len);
        z = z.min(display_len);
        let guard_state = super::super::guarded_words::GuardState::bind(
            guarded_words,
            &mut pieces,
            &mut link_metadata_items,
        )?;
        Ok(Context {
            typed_inputs,
            guard_state,
            raw,
            source_start,
            source_end,
            a,
            z,
            markers,
            pieces,
            block_boundaries,
            pending_links,
            link_metadata_items,
        })
    }
}

pub(in crate::inline) struct Context {
    pub(in crate::inline) typed_inputs: Vec<super::super::typed_angle::TypedAngleOrigin>,
    pub(in crate::inline) guard_state: super::super::guarded_words::GuardState,
    pub(in crate::inline) raw: String,
    pub(in crate::inline) source_start: usize,
    pub(in crate::inline) source_end: usize,
    pub(in crate::inline) a: usize,
    pub(in crate::inline) z: usize,
    pub(in crate::inline) markers: Vec<Marker>,
    pub(in crate::inline) pieces: Vec<Piece>,
    pub(in crate::inline) block_boundaries: Vec<usize>,
    pub(in crate::inline) pending_links: Vec<Range<usize>>,
    pub(in crate::inline) link_metadata_items: usize,
}

/// Whether `output` replacing source `start..end` changes no emphasis
/// delimiter run: the differing middle and the bytes beside it hold none.
fn neutral_replacement(source: &Rope, start: usize, end: usize, output: &str) -> bool {
    let raw = source.byte_slice(start..end).to_string();
    let (raw, new) = (raw.as_bytes(), output.as_bytes());
    let prefix = raw.iter().zip(new).take_while(|(a, b)| a == b).count();
    let room = raw.len().min(new.len()) - prefix;
    let suffix = raw
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take(room)
        .take_while(|(a, b)| a == b)
        .count();
    let byte = |at: usize| (at < source.len_bytes()).then(|| source.byte(at));
    let before = match prefix {
        0 => start.checked_sub(1).and_then(byte),
        _ => Some(raw[prefix - 1]),
    };
    let after = match suffix {
        0 => byte(end),
        _ => Some(raw[raw.len() - suffix]),
    };
    super::super::row::delimiter_neutral(
        &raw[prefix..raw.len() - suffix],
        &new[prefix..new.len() - suffix],
        before,
        after,
    )
}
