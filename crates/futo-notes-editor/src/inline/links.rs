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
        self.all_links(range)
            .into_iter()
            .filter(|link| !self.literal_links.contains(&link.range))
            .collect()
    }

    pub(crate) fn all_links(&self, range: crate::DisplayRange) -> Vec<crate::LinkDescription> {
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
        let mut at = 0;
        let mut existing = Vec::new();
        for piece in &pieces {
            let end = at + piece.display.len();
            if at < z && a < end {
                existing.extend(
                    piece
                        .spans
                        .iter()
                        .copied()
                        .filter(|id| matches!(markers[*id].kind, SpanKind::Link(_))),
                );
            }
            at = end;
        }
        existing.sort_unstable();
        existing.dedup();
        if existing.len() == 1 && !destination.is_empty() {
            let marker = &mut markers[existing[0]];
            marker.kind = SpanKind::Link(destination.into());
            if marker.open == "[" && marker.close.starts_with("](") {
                marker.close = replace_destination(&marker.close, destination);
            } else {
                marker.open = "[".into();
                marker.close = format!("](<{}>)", destination_source(destination));
            }
        } else {
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

/// GFM's parser decides link extent and destination. The cheap trigger only
/// avoids a second parser for paragraphs that cannot contain a URL or email.
pub(super) fn bare_links(source: &str) -> (Vec<super::row::Span>, usize) {
    if !source.contains(':') && !source.contains("www.") && !source.contains('@') {
        return (Vec::new(), 0);
    }
    let options = markdown::ParseOptions {
        constructs: markdown::Constructs {
            gfm_autolink_literal: true,
            ..Default::default()
        },
        ..Default::default()
    };
    let tree =
        markdown::to_mdast(source, &options).expect("CommonMark with GFM literals is infallible");
    let mut spans = Vec::new();
    let mut pending = vec![&tree];
    while let Some(node) = pending.pop() {
        if let markdown::mdast::Node::Link(link) = node {
            if let Some(position) = &link.position {
                let start = position.start.offset;
                let end = position.end.offset;
                if !source[start..end].starts_with(['[', '<']) {
                    spans.push(super::row::Span {
                        kind: super::row::SpanKind::Link(link.url.clone()),
                        open: start..start,
                        close: end..end,
                    });
                }
            }
            // Existing link labels cannot contain independent nested links.
            continue;
        }
        if let Some(children) = node.children() {
            pending.extend(children.iter().rev());
        }
    }
    (spans, source.len())
}

/// Preserve the existing wrapper and title bytes while replacing only its
/// destination token. Reference and autolink spellings use explicit syntax
/// when the command changes their destination.
fn replace_destination(close: &str, destination: &str) -> String {
    let start = 2 + close[2..].len() - close[2..].trim_start_matches([' ', '\t', '\r', '\n']).len();
    let angled = close[start..].starts_with('<');
    let mut depth = 0;
    let mut escaped = false;
    let mut end = start + usize::from(angled);
    for (at, ch) in close[end..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if angled && ch == '>' || !angled && depth == 0 && (ch == ')' || ch.is_ascii_whitespace()) {
            end += at;
            break;
        }
        if !angled && ch == '(' {
            depth += 1;
        }
        if !angled && ch == ')' {
            depth -= 1;
        }
    }
    if angled {
        format!(
            "{}{}{}",
            &close[..start + 1],
            destination_source(destination),
            &close[end..]
        )
    } else {
        let text = destination_source(destination);
        let text = if text.contains([' ', '(', ')']) {
            format!("<{text}>")
        } else {
            text
        };
        format!("{}{text}{}", &close[..start], &close[end..])
    }
}

impl super::Projection {
    pub(super) fn suppressed_link(
        &self,
        row: &super::row::Row,
        span: &super::row::Span,
        display: usize,
    ) -> bool {
        span.open.is_empty()
            && span.close.is_empty()
            && self.literal_links.contains(&crate::DisplayRange {
                start: crate::DisplayOffset(display + row.display_at(span.open.end)),
                end: crate::DisplayOffset(display + row.display_at(span.close.start)),
            })
    }

    pub(crate) fn finish_link_input(
        &mut self,
        input: crate::DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        caret: usize,
    ) {
        // Remap pending ranges to their parser-owned glyph extent after local
        // punctuation or an escaped delimiter changed the surrounding spelling.
        self.literal_links = self
            .literal_links
            .iter()
            .filter_map(|pending| {
                self.all_links(*pending)
                    .into_iter()
                    .find(|link| link.range.start == pending.start)
                    .map(|link| link.range)
            })
            .collect();
        let word_bytes: usize = self
            .display
            .chars_at(self.display.byte_to_char(caret))
            .reversed()
            .take_while(|ch| !ch.is_whitespace())
            .map(char::len_utf8)
            .sum();
        let word = crate::DisplayRange {
            start: crate::DisplayOffset(caret - word_bytes),
            end: crate::DisplayOffset(caret),
        };
        let candidates = self.all_links(word);
        if action == crate::InputAction::Typing
            && !inserted.is_empty()
            && !inserted.chars().last().unwrap().is_whitespace()
        {
            for link in candidates {
                let (row, _, display) = self.rows.at(self.rows.locate(link.range.start.0, true));
                let bare = row.spans.iter().any(|span| {
                    span.open.is_empty()
                        && span.close.is_empty()
                        && display + row.display_at(span.open.end) == link.range.start.0
                        && display + row.display_at(span.close.start) == link.range.end.0
                });
                if bare
                    && link.range.end.0 <= caret
                    && link.range.start.0 < input.start.0 + inserted.len()
                    && !self.literal_links.contains(&link.range)
                {
                    self.literal_links.push(link.range);
                }
            }
        }
        if inserted.contains(char::is_whitespace) {
            let last_word = inserted
                .rsplit(char::is_whitespace)
                .next()
                .unwrap_or("")
                .len();
            let ended = caret - last_word;
            self.literal_links
                .retain(|link| !(input.start.0 <= link.end.0 && link.end.0 <= ended));
        }
    }
}
