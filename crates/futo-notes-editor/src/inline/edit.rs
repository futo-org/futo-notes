//! Local marker surgery. Visible pieces retain their original source spelling
//! and span identity; only spans that lose content or cross the edited range
//! move. The parser remains the authority for interpreting candidate source.
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
fn common_prefix(a: &str, b: &str) -> usize {
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
        } = self.edit_context(source, range);
        let expanded = split_entities(pieces, a, z);
        let Cut {
            mut before,
            after,
            left,
            right,
        } = cut(expanded, a..z, toggle.is_some());
        let mut active = if a == z && affinity == Affinity::Backward {
            left
        } else {
            right
        };
        if let Some(formats) = pending {
            carry_formats(&mut before, &mut markers, &mut active, formats);
        }
        let formats = active
            .iter()
            .map(|id| markers[*id].format)
            .collect::<Vec<_>>();
        let mut changed = before;
        let insertion_index = changed.len();
        changed.extend(inserted.chars().map(|ch| Piece {
            raw: ch.to_string(),
            display: ch.to_string(),
            spans: active.clone(),
        }));
        let insertion_end = changed.len();
        changed.extend(after);
        // A native line break stays a line break. Split inline code around it
        // rather than allowing CommonMark code-space normalization to eat it.
        for piece in &mut changed {
            if piece.display.contains(['\r', '\n']) {
                piece
                    .spans
                    .retain(|id| markers[*id].format != InlineFormat::Code);
            }
        }
        if let Some(format) = toggle {
            toggle_pieces(&mut changed, &mut markers, a..z, format);
        }
        let literal = toggle.is_some()
            || inserted.is_empty()
            || !inserted.contains(['*', '_', '~', '`', '\\', '&', '<', '>'])
            || active
                .iter()
                .any(|id| markers[*id].format == InlineFormat::Code);
        let rendered = spell(changed, markers, insertion_index..insertion_end, literal)?;
        let parsed = rendered.parsed;
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
    fn edit_context(&self, source: &Rope, range: DisplayRange) -> Context {
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
        for index in first..=last {
            let (row, row_source, _) = self.rows.at(index);
            let base = row_source - source_start;
            let span_base = markers.len();
            markers.extend(row.spans.iter().map(|span| Marker {
                format: span.format,
                open: raw[base + span.open.start..base + span.open.end].into(),
                close: raw[base + span.close.start..base + span.close.end].into(),
            }));
            for segment in &row.segments {
                if segment.display.is_empty() {
                    continue;
                }
                let active = row
                    .spans
                    .iter()
                    .enumerate()
                    .filter(|(_, span)| {
                        span.open.end <= segment.source.start
                            && segment.source.end <= span.close.start
                    })
                    .map(|(i, _)| span_base + i)
                    .collect();
                pieces.push(Piece {
                    raw: raw[base + segment.source.start..base + segment.source.end].to_owned(),
                    display: row.display[segment.display.clone()].to_owned(),
                    spans: active,
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

struct Context {
    raw: String,
    source_start: usize,
    source_end: usize,
    a: usize,
    z: usize,
    markers: Vec<Marker>,
    pieces: Vec<Piece>,
}
struct Cut {
    before: Vec<Piece>,
    after: Vec<Piece>,
    left: Vec<usize>,
    right: Vec<usize>,
}

fn split_entities(pieces: Vec<Piece>, a: usize, z: usize) -> Vec<Piece> {
    let mut expanded = Vec::new();
    let mut position = 0;
    for piece in pieces {
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
                });
            }
        }
        position = end;
    }
    expanded
}

fn cut(expanded: Vec<Piece>, selected: Range<usize>, keep: bool) -> Cut {
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
        if keep || end <= a {
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

fn carry_formats(
    before: &mut [Piece],
    markers: &mut Vec<Marker>,
    active: &mut Vec<usize>,
    formats: &[InlineFormat],
) {
    active.retain(|id| formats.contains(&markers[*id].format));
    for &format in formats {
        if !active.iter().any(|id| markers[*id].format == format) {
            let previous = before
                .iter()
                .rev()
                .find(|piece| !piece.display.chars().all(char::is_whitespace));
            let reusable = previous.and_then(|piece| {
                piece
                    .spans
                    .iter()
                    .copied()
                    .find(|id| markers[*id].format == format)
            });
            let id = if let Some(id) = reusable {
                for piece in before.iter_mut().rev() {
                    if !piece.display.chars().all(char::is_whitespace) {
                        break;
                    }
                    piece.spans.push(id);
                }
                id
            } else {
                let delimiter = delimiter(format);
                let id = markers.len();
                markers.push(Marker {
                    format,
                    open: delimiter.into(),
                    close: delimiter.into(),
                });
                id
            };
            active.push(id);
        }
    }
}

fn toggle_pieces(
    changed: &mut [Piece],
    markers: &mut Vec<Marker>,
    selected: Range<usize>,
    format: InlineFormat,
) {
    let (a, z) = (selected.start, selected.end);
    // Formatting commands modify only the selected visible pieces.
    let mut start = 0;
    let all_active = changed
        .iter()
        .filter(|piece| {
            let end = start + piece.display.len();
            let hit = start < z && a < end;
            start = end;
            hit
        })
        .all(|piece| piece.spans.iter().any(|id| markers[*id].format == format));
    let id = markers.len();
    let delimiter = delimiter(format);
    markers.push(Marker {
        format,
        open: delimiter.into(),
        close: delimiter.into(),
    });
    let mut start = 0;
    for piece in changed {
        let end = start + piece.display.len();
        if start < z && a < end {
            piece.spans.retain(|id| markers[*id].format != format);
            if format == InlineFormat::Code {
                if all_active {
                    piece.raw = piece
                        .display
                        .chars()
                        .map(|ch| {
                            if ch.is_ascii_punctuation() {
                                format!("&#{};", ch as u32)
                            } else {
                                ch.to_string()
                            }
                        })
                        .collect();
                } else if !piece.display.contains(['\r', '\n']) {
                    piece.spans.push(id);
                    piece.raw.clone_from(&piece.display);
                }
            } else if !all_active {
                piece.spans.insert(0, id);
            }
        }
        start = end;
    }
}
