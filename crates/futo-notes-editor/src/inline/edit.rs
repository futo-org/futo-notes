//! Local marker surgery. Visible pieces retain their original source spelling
//! and span identity; only spans that lose content or cross the edited range
//! move. The parser remains the authority for interpreting candidate source.
mod carry;
mod selection;
mod source;
use super::row::SpanKind;
use super::{
    spelling::{spell, Marker, Piece},
    Projection,
};
use crate::{Affinity, DisplayRange, EditorError, InlineFormat};
pub(super) use carry::carry_formats;
use ropey::Rope;
pub(super) use selection::{cut, split_entities, Cut};
pub(crate) use source::SourceCorrespondence;
use std::ops::Range;

#[derive(Clone, Copy)]
pub(crate) enum EditIntent {
    Input(crate::InputAction),
    Toggle(InlineFormat),
}

pub(crate) struct Plan {
    pub retained: SourceCorrespondence,
    pub requires_source_identity: bool,
    pub range: Range<usize>,
    pub delimiters: Vec<Range<usize>>,
    pub inserted: String,
    pub caret: usize,
    pub input_start: usize,
    pub formats: Vec<InlineFormat>,
    pub materialized: usize,
    pub parsed: usize,
    pub link_metadata_items: usize,
    pub link_copied_bytes: usize,
}
pub(super) fn common_prefix(a: &str, b: &str) -> usize {
    a.chars()
        .zip(b.chars())
        .take_while(|(a, b)| a == b)
        .map(|(c, _)| c.len_utf8())
        .sum()
}

impl Projection {
    pub fn edit(
        &self,
        source: &Rope,
        range: DisplayRange,
        inserted: &str,
        affinity: Affinity,
        pending: Option<&[InlineFormat]>,
        intent: EditIntent,
    ) -> Result<Plan, EditorError> {
        let toggle = match intent {
            EditIntent::Toggle(format) => Some(format),
            _ => None,
        };
        let Context {
            raw,
            source_start,
            source_end,
            a,
            z,
            mut markers,
            pieces,
            block_boundaries,
            link_metadata_items,
        } = self.edit_context_for_change(source, range, toggle.is_none().then_some(inserted));
        let expanded = split_entities(pieces, a, z);
        let Cut {
            mut before,
            mut after,
            left,
            right,
        } = cut(expanded, a..z, toggle.is_some());
        let mut active = if a == z && affinity == Affinity::Backward {
            left
        } else {
            right
        };
        if let Some(formats) = pending {
            carry_formats(&mut before, &after, &mut markers, &mut active, formats);
        }
        let formats = active
            .iter()
            .filter_map(|id| markers[*id].kind.format())
            .collect::<Vec<_>>();
        // Removing a line separator can bring equal-format delimiter runs
        // together. Join their identities at that seam instead of emitting
        // adjacent identical delimiters that CommonMark cannot distinguish.
        if inserted.is_empty() {
            if let (Some(left), Some(right)) = (before.last(), after.first()) {
                let joins: Vec<_> = left
                    .spans
                    .iter()
                    .zip(&right.spans)
                    .take_while(|(a, b)| {
                        markers[**a].kind == markers[**b].kind
                            && matches!(markers[**a].kind, SpanKind::Format(_))
                    })
                    .map(|(&a, &b)| (a, b))
                    .collect();
                for piece in &mut after {
                    for &(left, right) in &joins {
                        for id in &mut piece.spans {
                            if *id == right {
                                *id = left;
                            }
                        }
                    }
                }
            }
        }
        let mut changed = before;
        let insertion_index = changed.len();
        changed.extend(inserted.chars().map(|ch| Piece {
            raw: ch.to_string(),
            display: ch.to_string(),
            spans: active.clone(),
            trailing: false,
            definition: None,
            origin: None,
            timing: false,
        }));
        let insertion_end = changed.len();
        changed.extend(after);
        let boundaries: Vec<_> = block_boundaries
            .into_iter()
            .filter_map(|boundary| {
                if boundary <= a {
                    Some(boundary)
                } else if boundary >= z {
                    Some(boundary - (z - a) + inserted.len())
                } else {
                    None
                }
            })
            .collect();
        super::spelling::split_block_spans(&mut changed, &boundaries);
        // A native line break stays a line break. Split inline code around it
        // rather than allowing CommonMark code-space normalization to eat it.
        for piece in &mut changed {
            if piece.display.contains(['\r', '\n']) {
                piece
                    .spans
                    .retain(|id| markers[*id].kind != SpanKind::Format(InlineFormat::Code));
            }
        }
        if let Some(format) = toggle {
            let opaque: Vec<_> = self
                .block_lines(range)
                .into_iter()
                .filter(|line| line.code)
                .map(|line| {
                    self.display_at(line.content.start) - self.display_at(source_start)
                        ..self.display_at(line.content.end) - self.display_at(source_start)
                })
                .collect();
            super::toggle::pieces(&mut changed, &mut markers, a..z, format, &opaque);
        }
        let speculative_block = inserted
            .chars()
            .all(|ch| matches!(ch, '#' | '>' | '*' | '_'))
            && self
                .display
                .byte_slice(
                    self.display
                        .line_to_byte(self.display.byte_to_line(range.start.0))
                        ..range.start.0,
                )
                .chars()
                .all(|ch| matches!(ch, '#' | '>' | '*' | '_'));
        let display_line = self
            .display
            .line_to_byte(self.display.byte_to_line(range.start.0));
        let prefix = format!(
            "{}{}",
            self.display.byte_slice(display_line..range.start.0),
            inserted
        );
        let speculative_fence = (prefix.starts_with("```") || prefix.starts_with("~~~"))
            && !prefix.contains(char::is_whitespace);
        let mut literal = inserted.contains(['<', '>'])
            || speculative_fence
            || speculative_block
            || toggle.is_some()
            || inserted.is_empty()
            || !inserted.contains(['*', '_', '~', '`', '\\', '&', '<', '>'])
            || active
                .iter()
                .any(|id| markers[*id].kind == SpanKind::Format(InlineFormat::Code));
        let link_work =
            super::links::finish_angle_word(&mut changed, &mut markers, insertion_index, inserted);
        let timing = if let EditIntent::Input(action) = intent {
            super::spelling::prepare_url_input(
                &mut changed,
                &markers,
                insertion_index..insertion_end,
                inserted,
                action,
                &self.references,
            )
        } else {
            Default::default()
        };
        if let Some(value) = timing.literal {
            literal = value;
        }
        let mut rendered = spell(
            changed,
            markers,
            insertion_index..insertion_end,
            literal,
            &self.references,
        )?;
        let delimiter_work = rendered.relocate_delimiters(source_start);
        let parsed = rendered.parsed + link_work.parsed;
        let output = rendered.text;
        let caret = rendered.caret;
        let (retained, correspondence_work) =
            SourceCorrespondence::verify(&raw, &output, rendered.origins, source_start);
        let prefix = common_prefix(&raw, &output);
        let suffix: usize = raw[prefix..]
            .chars()
            .rev()
            .zip(output[prefix..].chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(c, _)| c.len_utf8())
            .sum();
        Ok(Plan {
            retained,
            requires_source_identity: !literal,
            delimiters: rendered.delimiters,
            range: source_start + prefix..source_end - suffix,
            inserted: output[prefix..output.len() - suffix].to_owned(),
            caret: source_start + caret,
            input_start: source_start + rendered.input_start,
            formats,
            materialized: raw.len() + output.len() + timing.materialized,
            parsed: parsed + timing.work.parsed,
            link_metadata_items: link_metadata_items
                + delimiter_work
                + correspondence_work
                + timing.work.items
                + rendered.link_metadata_items
                + link_work.items,
            link_copied_bytes: rendered.link_copied_bytes + link_work.copied + timing.work.copied,
        })
    }
    pub(super) fn edit_context(&self, source: &Rope, range: DisplayRange) -> Context {
        self.edit_context_for_change(source, range, None)
    }

    fn edit_context_for_change(
        &self,
        source: &Rope,
        range: DisplayRange,
        replacement: Option<&str>,
    ) -> Context {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        let (_, source_start, display_start) = self.rows.at(first);
        let (end_row, source_end, _) = self.rows.at(last);
        let source_end = source_end + end_row.source_len;
        let raw = source.byte_slice(source_start..source_end).to_string();
        let mut markers = Vec::new();
        let mut link_metadata_items = 0;
        let mut pieces = Vec::<Piece>::new();
        let mut a = range.start.0 - display_start;
        let mut z = range.end.0 - display_start;
        let mut display_len = 0;
        let mut block_boundaries = Vec::new();
        let may_empty_heading = replacement.is_some_and(|text| {
            text.split('\n')
                .any(|line| line.trim_matches([' ', '\t', '\r']).is_empty())
        });
        let mut selected_body_before = false;
        for index in first..=last {
            let (row, row_source, row_display) = self.rows.at(index);
            let base = row_source - source_start;
            let span_base = markers.len();
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
                Marker {
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
                        super::references::hidden_definition(
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
                            raw: raw[base + range.start..base + range.end].into(),
                            display: String::new(),
                            spans: Vec::new(),
                            trailing: true,
                            definition: Some(key.clone()),
                            origin: Some(base + range.start..base + range.end),
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
                        !self.suppressed_link(row, span, row_display)
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
                        raw: raw[base + segment.source.start..base + segment.source.end].to_owned(),
                        display: String::new(),
                        spans: active,
                        trailing,
                        definition: None,
                        origin: Some(base + segment.source.start..base + segment.source.end),
                        timing: false,
                    });
                    continue;
                }
                pieces.push(Piece {
                    raw: raw[base + segment.source.start..base + segment.source.end].to_owned(),
                    display: row.display[segment.display.clone()].to_owned(),
                    spans: active,
                    trailing: false,
                    definition: None,
                    origin: Some(base + segment.source.start..base + segment.source.end),
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
        Context {
            raw,
            source_start,
            source_end,
            a,
            z,
            markers,
            pieces,
            block_boundaries,
            link_metadata_items,
        }
    }
}

pub(crate) fn delimiter(format: InlineFormat) -> &'static str {
    match format {
        InlineFormat::Bold => "**",
        InlineFormat::Italic => "*",
        InlineFormat::Strike => "~~",
        InlineFormat::Code => "`",
    }
}

pub(super) struct Context {
    pub(super) raw: String,
    pub(super) source_start: usize,
    pub(super) source_end: usize,
    pub(super) a: usize,
    pub(super) z: usize,
    pub(super) markers: Vec<Marker>,
    pub(super) pieces: Vec<Piece>,
    pub(super) block_boundaries: Vec<usize>,
    pub(super) link_metadata_items: usize,
}
