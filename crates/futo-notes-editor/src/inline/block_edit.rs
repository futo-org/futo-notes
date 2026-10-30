//! Plan local marker repairs before changing visible block lines.
use super::row::SpanKind;
use super::{
    edit::{common_prefix, Context, Plan},
    spelling::spell,
    Projection,
};
use crate::{DisplayRange, EditorError, InlineFormat};
use ropey::Rope;

impl Projection {
    /// Spell only the visible body, retaining existing inline identities while
    /// removing the structural pieces owned by the surrounding block.
    pub(crate) fn body_source(
        &self,
        source: &Rope,
        range: DisplayRange,
        fold_breaks: bool,
    ) -> Result<(String, usize, usize, super::references::ReferenceWork), EditorError> {
        let Context {
            raw,
            source_start,
            pieces,
            markers,
            link_metadata_items,
            ..
        } = self.edit_context(source, range);
        let base = self.display_at(source_start);
        let mut at = base;
        let mut body = Vec::new();
        let mut cr = false;
        for mut piece in pieces {
            let end = at + piece.display.len();
            if !piece.display.is_empty() && range.start.0 <= at && end <= range.end.0 {
                if fold_breaks && piece.display == "\n" && cr {
                    cr = false;
                    at = end;
                    continue;
                }
                cr = fold_breaks && piece.display == "\r";
                if fold_breaks && piece.display.contains(['\r', '\n']) {
                    piece.raw = " ".into();
                    piece.display = " ".into();
                }
                body.push(piece);
            }
            at = end;
        }
        let end = body.len();
        let result = spell(body, markers, end..end, true, &self.references)?;
        let materialized = raw.len() + result.text.len();
        Ok((
            result.text,
            materialized,
            result.parsed,
            super::references::ReferenceWork {
                parsed: 0,
                items: link_metadata_items + result.link_metadata_items,
                copied: result.link_copied_bytes,
            },
        ))
    }

    pub(crate) fn has_multiline_block_code(&self, source: &Rope, range: DisplayRange) -> bool {
        let (first_line, last_line) = self.touched_display_lines(range);
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        (first..=last).any(|index| {
            let (row, base, display) = self.rows.at(index);
            row.spans.iter().any(|span| {
                let line = self
                    .display
                    .byte_to_line(display + row.display_at(span.open.end));
                span.kind == SpanKind::Format(InlineFormat::Code)
                    && first_line <= line
                    && line <= last_line
                    && source.byte_to_line(base + span.open.end)
                        < source.byte_to_line(base + span.close.start)
            })
        })
    }

    fn touched_display_lines(&self, range: DisplayRange) -> (usize, usize) {
        let first = self.display.byte_to_line(range.start.0);
        let mut last = self.display.byte_to_line(range.end.0);
        if range.start != range.end
            && last > first
            && self.display.line_to_byte(last) == range.end.0
        {
            last -= 1;
        }
        (first, last)
    }

    pub(crate) fn line_boundaries(&self, range: DisplayRange) -> Vec<usize> {
        let (first, last) = self.touched_display_lines(range);
        (first..=(last + 1).min(self.display.len_lines() - 1))
            .map(|line| self.display.line_to_byte(line))
            .filter(|&boundary| {
                let (row, _, display) = self.rows.at(self.rows.locate(boundary, true));
                !row.blocks.iter().any(|block| {
                    block.heading_syntax == super::blocks::HeadingSyntax::Setext
                        && display + row.display_at(block.content.start) < boundary
                        && boundary < display + row.display_at(block.content.end)
                })
            })
            .collect()
    }

    pub(crate) fn has_block_seams(&self, range: DisplayRange) -> bool {
        self.has_block_seams_at(range, &self.line_boundaries(range))
    }

    pub(crate) fn has_block_seams_at(&self, range: DisplayRange, boundaries: &[usize]) -> bool {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        boundaries.iter().copied().any(|boundary| {
            let (low, high) = self.source_bounds(boundary);
            (first..=last).any(|index| {
                let (row, source, _) = self.rows.at(index);
                row.spans
                    .iter()
                    .any(|span| source + span.open.end < low && high < source + span.close.start)
            })
        })
    }

    pub(crate) fn split_block_lines(
        &self,
        source: &Rope,
        range: DisplayRange,
        boundaries: &[usize],
    ) -> Result<Option<Plan>, EditorError> {
        if !self.has_block_seams_at(range, boundaries)
            && !self.has_multiline_block_code(source, range)
        {
            return Ok(None);
        }
        let Context {
            raw,
            source_start,
            source_end,
            mut pieces,
            markers,
            link_metadata_items,
            ..
        } = self.edit_context(source, range);
        let display_start = self.display_at(source_start);
        let boundaries: Vec<_> = boundaries
            .iter()
            .map(|boundary| boundary - display_start)
            .collect();
        super::spelling::split_block_spans(&mut pieces, &boundaries);
        let (first_line, last_line) = self.touched_display_lines(range);
        let mut at = display_start;
        for piece in &mut pieces {
            let line = self.display.byte_to_line(at);
            if first_line <= line
                && line <= last_line
                && piece
                    .spans
                    .iter()
                    .any(|id| markers[*id].kind == SpanKind::Format(InlineFormat::Code))
                && (piece.raw.contains(['\r', '\n']) || piece.display.is_empty() && !piece.trailing)
            {
                // Inline code normalizes a physical source break to one visible
                // space. Keep that visible line whole before adding a block seam.
                piece.raw.clone_from(&piece.display);
            }
            at += piece.display.len();
        }
        let end = pieces.len();
        let rendered = spell(pieces, markers, end..end, true, &self.references)?;
        if rendered.text == raw {
            return Ok(None);
        }
        let prefix = common_prefix(&raw, &rendered.text);
        let suffix: usize = raw[prefix..]
            .chars()
            .rev()
            .zip(rendered.text[prefix..].chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(ch, _)| ch.len_utf8())
            .sum();
        Ok(Some(Plan {
            delimiters: Vec::new(),
            input_start: 0,
            range: source_start + prefix..source_end - suffix,
            inserted: rendered.text[prefix..rendered.text.len() - suffix].to_owned(),
            caret: source_start,
            formats: Vec::new(),
            materialized: raw.len() + rendered.text.len(),
            parsed: rendered.parsed,
            link_metadata_items: link_metadata_items + rendered.link_metadata_items,
            link_copied_bytes: rendered.link_copied_bytes,
        }))
    }
}
