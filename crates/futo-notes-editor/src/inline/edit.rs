//! Local marker surgery. Visible pieces retain their original source spelling
//! and span identity; only spans that lose content or cross the edited range
//! move. The parser remains the authority for interpreting candidate source.
use super::row::SpanKind;
use super::{
    spelling::{spell, Marker, Piece},
    Projection,
};
use crate::{Affinity, DisplayRange, EditorError, InlineFormat};
use ropey::Rope;
use std::ops::Range;

pub(crate) struct Plan {
    pub range: Range<usize>,
    pub inserted: String,
    pub caret: usize,
    pub formats: Vec<InlineFormat>,
    pub materialized: usize,
    pub parsed: usize,
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
        toggle: Option<InlineFormat>,
    ) -> Result<Plan, EditorError> {
        let Context {
            raw,
            source_start,
            source_end,
            a,
            z,
            mut markers,
            pieces,
            block_boundaries,
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
        let literal = inserted.contains(['<', '>'])
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
        let rendered = spell(
            changed,
            markers,
            insertion_index..insertion_end,
            literal,
            &self.references,
        )?;
        let parsed = rendered.parsed + link_work;
        let output = rendered.text;
        let caret = rendered.caret;
        let prefix = common_prefix(&raw, &output);
        let suffix: usize = raw[prefix..]
            .chars()
            .rev()
            .zip(output[prefix..].chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(c, _)| c.len_utf8())
            .sum();
        Ok(Plan {
            range: source_start + prefix..source_end - suffix,
            inserted: output[prefix..output.len() - suffix].to_owned(),
            caret: source_start + caret,
            formats,
            materialized: raw.len() + output.len(),
            parsed,
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
            markers.extend(row.spans.iter().map(|span| Marker {
                kind: span.kind.clone(),
                open: raw[base + span.open.start..base + span.open.end].into(),
                close: raw[base + span.close.start..base + span.close.end].into(),
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
            for segment in &row.segments {
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
                    });
                    continue;
                }
                pieces.push(Piece {
                    raw: raw[base + segment.source.start..base + segment.source.end].to_owned(),
                    display: row.display[segment.display.clone()].to_owned(),
                    spans: active,
                    trailing: false,
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
}
pub(super) struct Cut {
    pub(super) before: Vec<Piece>,
    pub(super) after: Vec<Piece>,
    pub(super) left: Vec<usize>,
    pub(super) right: Vec<usize>,
}

pub(super) fn split_entities(pieces: Vec<Piece>, a: usize, z: usize) -> Vec<Piece> {
    let mut expanded = Vec::new();
    let mut position = 0;
    for piece in pieces {
        if piece.display.is_empty() {
            expanded.push(piece);
            continue;
        }
        let end = position + piece.display.len();
        let mut cuts = vec![0, piece.display.len()];
        for boundary in [a, z] {
            if position < boundary && boundary < end {
                cuts.push(boundary - position);
            }
        }
        cuts.sort_unstable();
        cuts.dedup();
        if cuts.len() == 2 {
            expanded.push(piece);
        } else {
            for pair in cuts.windows(2) {
                let display = piece.display[pair[0]..pair[1]].to_owned();
                let raw = if piece.raw == piece.display {
                    display.clone()
                } else {
                    display
                        .chars()
                        .map(|ch| format!("&#{};", ch as u32))
                        .collect()
                };
                expanded.push(Piece {
                    raw,
                    display,
                    spans: piece.spans.clone(),
                    trailing: piece.trailing,
                });
            }
        }
        position = end;
    }
    expanded
}

pub(super) fn cut(expanded: Vec<Piece>, selected: Range<usize>, keep: bool) -> Cut {
    let (a, z) = (selected.start, selected.end);
    let mut offset = 0;
    let mut before = Vec::new();
    let mut after = Vec::new();
    let mut left = Vec::new();
    let mut right = Vec::new();
    for piece in expanded {
        let end = offset + piece.display.len();
        if offset < a && a <= end {
            left = piece.spans.clone();
        }
        if offset <= a && a < end {
            right = piece.spans.clone();
        }
        if piece.display.is_empty() && !piece.trailing && offset == z && a < z && !keep {
            // Joining lines retires the following line's block prefix. Its
            // inline spans still join through their visible pieces below.
        } else if piece.display.is_empty() && piece.trailing && offset >= z && !keep {
            after.push(piece);
        } else if keep || end <= a {
            before.push(piece);
        } else if offset >= z {
            after.push(piece);
        }
        // Scalar segments have no internal UTF-8 boundaries. Decoded text
        // events are split by the parser; preserve their raw atom intact.
        offset = end;
    }
    Cut {
        before,
        after,
        left,
        right,
    }
}

pub(super) fn carry_formats(
    before: &mut [Piece],
    after: &[Piece],
    markers: &mut Vec<Marker>,
    active: &mut Vec<usize>,
    formats: &[InlineFormat],
) {
    active.retain(|id| {
        markers[*id]
            .kind
            .format()
            .is_none_or(|format| formats.contains(&format))
    });
    for &format in formats {
        if !active
            .iter()
            .any(|id| markers[*id].kind == SpanKind::Format(format))
        {
            let previous = before
                .iter()
                .rev()
                .take_while(|piece| {
                    !piece.display.contains(['\r', '\n'])
                        && !(piece.display.is_empty() && !piece.raw.is_empty())
                })
                .find(|piece| !piece.display.chars().all(char::is_whitespace));
            let neighbor =
                previous.or_else(|| after.iter().find(|piece| !piece.display.is_empty()));
            let reusable = neighbor.and_then(|piece| {
                piece
                    .spans
                    .iter()
                    .copied()
                    .find(|id| markers[*id].kind == SpanKind::Format(format))
            });
            let id = if let Some(id) = reusable {
                for piece in before.iter_mut().rev() {
                    if piece.display.contains(['\r', '\n'])
                        || piece.display.is_empty() && !piece.raw.is_empty()
                        || !piece.display.chars().all(char::is_whitespace)
                    {
                        break;
                    }
                    piece.spans.push(id);
                }
                id
            } else {
                let delimiter = delimiter(format);
                let spelling = before.iter().rev().chain(after.iter()).find_map(|piece| {
                    piece
                        .spans
                        .iter()
                        .find(|id| markers[**id].kind == SpanKind::Format(format))
                        .map(|id| (markers[*id].open.clone(), markers[*id].close.clone()))
                });
                let id = markers.len();
                let (open, close) =
                    spelling.unwrap_or_else(|| (delimiter.into(), delimiter.into()));
                markers.push(Marker {
                    kind: SpanKind::Format(format),
                    open,
                    close,
                });
                id
            };
            active.push(id);
        }
    }
}
