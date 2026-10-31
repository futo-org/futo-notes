//! Canonical source pieces and spans for one input context.
use super::*;

impl Projection {
    pub(in crate::inline) fn edit_context(
        &self,
        source: &Rope,
        range: DisplayRange,
    ) -> Result<Context, crate::EditorError> {
        self.edit_context_for_change(source, range, None)
    }

    pub(super) fn edit_context_for_change(
        &self,
        source: &Rope,
        range: DisplayRange,
        replacement: Option<&str>,
    ) -> Result<Context, crate::EditorError> {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        let (_, source_start, display_start) = self.rows.at(first);
        let (end_row, source_end, _) = self.rows.at(last);
        let source_end = source_end + end_row.source_len;
        let raw = source.byte_slice(source_start..source_end).to_string();
        let mut markers = Vec::new();
        let mut guarded_words = Vec::new();
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
            let (row, row_source, row_display) = self.rows.at(index);
            let base = row_source - source_start;
            link_metadata_items += super::super::guarded_words::validate_row(
                &raw[base..base + row.source_len],
                row,
                &row.guarded_words,
            )?;
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
            markers.extend(row.spans.iter().map(|span| {
                if matches!(span.kind, SpanKind::Link(_)) {
                    link_metadata_items += 1;
                }
                let pending = !span.open.is_empty()
                    && matches!(span.kind, SpanKind::Link(_))
                    && row.literal_links.iter().any(|range| {
                        link_metadata_items += 1;
                        *range == (span.open.end..span.close.start)
                    });
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
            }));
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
                    definition.winner
                        && row.display_at(definition.range.start)
                            == row.display_at(definition.range.end)
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
                let active = row
                    .spans
                    .iter()
                    .enumerate()
                    .filter(|(_, span)| {
                        (!self.suppressed_link(row, span, row_display) || !span.open.is_empty())
                            && span.open.end <= segment.source.start
                            && segment.source.end <= span.close.start
                    })
                    .map(|(i, _)| span_base + i)
                    .collect();
                if segment.display.is_empty() {
                    // Inline markers are reconstructed from spans; block markers
                    // are exact source pieces outside that inline stack.
                    if row.spans.iter().any(|span| {
                        span.open.start <= segment.source.start
                            && segment.source.end <= span.open.end
                            || span.close.start <= segment.source.start
                                && segment.source.end <= span.close.end
                    }) {
                        continue;
                    }
                    let trailing = row.blocks.iter().any(|block| {
                        !block.empty_comment
                            && block.content.end <= segment.source.start
                            && segment.source.end <= block.source.end
                    });
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
