//! Link source boundaries are owned here; destination interpretation comes from
//! the Markdown parser. Consumers receive destination semantics, never syntax.
use std::ops::Range;

pub(super) fn label_range(source: &str, whole: Range<usize>) -> Range<usize> {
    let raw = &source[whole.clone()];
    if raw.starts_with('<') {
        return whole.start + 1..whole.end - 1;
    }
    // A parsed link's label ends at the matching unescaped bracket. Nested
    // brackets belong to its label, including formatting/code inside it.
    let mut depth = 0;
    let mut escaped = false;
    for (at, ch) in raw.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '[' {
            depth += 1;
        }
        if ch == ']' {
            depth -= 1;
            if depth == 0 {
                return whole.start + 1..whole.start + at;
            }
        }
    }
    whole
}

impl super::Projection {
    pub(crate) fn link_descriptions(
        &self,
        range: crate::DisplayRange,
    ) -> Vec<crate::LinkDescription> {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        let mut links = Vec::new();
        for index in first..=last {
            let (row, _, display) = self.rows.at(index);
            for span in &row.spans {
                if let super::row::SpanKind::Link(destination) = &span.kind {
                    let start = display + row.display_at(span.open.end);
                    let end = display + row.display_at(span.close.start);
                    if start <= range.end.0 && range.start.0 <= end {
                        links.push(crate::LinkDescription {
                            range: crate::DisplayRange {
                                start: crate::DisplayOffset(start),
                                end: crate::DisplayOffset(end),
                            },
                            destination: destination.clone(),
                        });
                    }
                }
            }
        }
        links
    }
}

impl super::Projection {
    pub(crate) fn link_edit(
        &self,
        source: &ropey::Rope,
        range: crate::DisplayRange,
        destination: &str,
    ) -> Result<super::edit::Plan, crate::EditorError> {
        use super::{
            edit::{common_prefix, split_entities, Context, Plan},
            row::SpanKind,
            spelling::{spell, Marker},
        };
        let Context {
            raw,
            source_start,
            source_end,
            a,
            z,
            mut markers,
            pieces,
            ..
        } = self.edit_context(source, range);
        let mut pieces = split_entities(pieces, a, z);
        let id = markers.len();
        markers.push(Marker {
            kind: SpanKind::Link(destination.into()),
            open: "[".into(),
            close: format!("](<{}>)", destination_source(destination)),
        });
        let mut at = 0;
        for piece in &mut pieces {
            let end = at + piece.display.len();
            if at < z && a < end {
                piece
                    .spans
                    .retain(|id| !matches!(markers[*id].kind, SpanKind::Link(_)));
                if !destination.is_empty() {
                    piece.spans.insert(0, id);
                }
            }
            at = end;
        }
        let end = pieces.len();
        let rendered = spell(pieces, markers, end..end, true)?;
        let prefix = common_prefix(&raw, &rendered.text);
        let suffix: usize = raw[prefix..]
            .chars()
            .rev()
            .zip(rendered.text[prefix..].chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(ch, _)| ch.len_utf8())
            .sum();
        Ok(Plan {
            range: source_start + prefix..source_end - suffix,
            inserted: rendered.text[prefix..rendered.text.len() - suffix].into(),
            caret: 0,
            formats: Vec::new(),
            materialized: raw.len() + rendered.text.len(),
            parsed: rendered.parsed,
        })
    }
}

fn destination_source(destination: &str) -> String {
    let mut source = String::new();
    for ch in destination.chars() {
        match ch {
            '&' => source.push_str("&amp;"),
            '<' | '>' | '\\' => {
                source.push('\\');
                source.push(ch);
            }
            _ => source.push(ch),
        }
    }
    source
}
