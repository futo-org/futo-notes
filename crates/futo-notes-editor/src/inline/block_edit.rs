//! Plan local marker repairs before changing visible block lines.
use super::row::SpanKind;
use super::{
    edit::{common_prefix, Context, Plan},
    spelling::spell,
    Projection,
};
use crate::{DisplayRange, EditorError, InlineFormat, Revision};
use ropey::Rope;

pub(crate) struct BodySource {
    pub typed_inputs: Option<Vec<super::typed_angle::TypedAngleOrigin>>,
    pub guarded_words: Option<Vec<super::guarded_words::GuardedWord>>,
    pub text: String,
    pub revision: Revision,
    pub window: std::ops::Range<usize>,
    pub retained: Vec<super::references::RetainedBody>,
    pub materialized: usize,
    pub parsed: usize,
    pub work: super::references::ReferenceWork,
}

impl Projection {
    /// Spell only the visible body, retaining existing inline identities while
    /// removing the structural pieces owned by the surrounding block.
    pub(crate) fn body_source(
        &self,
        source: &Rope,
        range: DisplayRange,
        fold_breaks: bool,
        revision: Revision,
    ) -> Result<BodySource, EditorError> {
        let Context {
            typed_inputs,
            mut guard_state,
            raw,
            source_start,
            source_end,
            pieces,
            markers,
            mut link_metadata_items,
            ..
        } = self.edit_context(source, range)?;
        let (typed_inputs, typed_work) =
            self.scope_typed_origins(typed_inputs, source_start, range)?;
        link_metadata_items += typed_work;
        let base = self.display_at(source_start);
        link_metadata_items += guard_state.scope_body(&pieces, base, range.start.0..range.end.0)?;
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
        let result = spell(
            body,
            guard_state,
            super::typed_angle::TypedState::current(typed_inputs),
            &raw,
            markers,
            end..end,
            true,
            &self.references,
        )?;
        let mut retained = Vec::new();
        let mut measured = result.link_metadata_items;
        for (origin, after) in result.origins {
            measured += 1;
            if let super::spelling::PieceOrigin::Source(before) = origin {
                let Some(original) = raw.get(before.clone()) else {
                    continue;
                };
                let Some(rendered) = result.text.get(after.clone()) else {
                    continue;
                };
                if original.len() == rendered.len()
                    && original.bytes().zip(rendered.bytes()).all(|(a, b)| {
                        measured += 1;
                        a == b
                    })
                {
                    // Keep complete original parser-piece extents, including
                    // nonidentity atoms. Never split them to manufacture lineage.
                    measured += 2;
                    retained.push(super::references::RetainedBody {
                        before: source_start + before.start..source_start + before.end,
                        after,
                    });
                }
            }
        }
        let (ordered, visits) = super::references::RetainedBody::ordered(&retained);
        measured += visits;
        if !ordered {
            return Err(EditorError::UnrepresentableFormat);
        }
        let materialized = raw.len() + result.text.len() + result.materialized;
        Ok(BodySource {
            typed_inputs: result.typed_inputs,
            guarded_words: result.guarded_words,
            text: result.text,
            revision,
            window: source_start..source_end,
            retained,
            materialized,
            parsed: result.parsed,
            work: super::references::ReferenceWork {
                parsed: 0,
                items: link_metadata_items + measured,
                copied: result.link_copied_bytes,
            },
        })
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
        self.has_block_seams_with_work(range).0
    }

    pub(crate) fn has_block_seams_with_work(&self, range: DisplayRange) -> (bool, usize) {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        let mut work = 0;
        if !(first..=last).any(|index| {
            work += 1;
            !self.rows.at(index).0.spans.is_empty()
        }) {
            return (false, work);
        }
        let (found, inspected) =
            self.has_block_seams_at_with_work(range, &self.line_boundaries(range));
        (found, work + inspected)
    }

    pub(crate) fn has_block_seams_at(&self, range: DisplayRange, boundaries: &[usize]) -> bool {
        self.has_block_seams_at_with_work(range, boundaries).0
    }

    pub(crate) fn has_block_seams_at_with_work(
        &self,
        range: DisplayRange,
        boundaries: &[usize],
    ) -> (bool, usize) {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        let mut work = 0;
        // Source bounds advance monotonically with these ordered physical
        // boundaries. For each retained span, only the first boundary strictly
        // beyond its opener can lie strictly before its closer. Visiting spans
        // once avoids checking every unrelated row for every physical line.
        let found = (first..=last).any(|index| {
            work += 1;
            let (row, source, _) = self.rows.at(index);
            row.spans.iter().any(|span| {
                work += 1;
                let after_open = boundaries.partition_point(|&boundary| {
                    work += 1;
                    self.source_bounds(boundary).0 <= source + span.open.end
                });
                boundaries.get(after_open).is_some_and(|&boundary| {
                    work += 1;
                    self.source_bounds(boundary).1 < source + span.close.start
                })
            })
        });
        (found, work)
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
            typed_inputs,
            guard_state,
            raw,
            source_start,
            source_end,
            mut pieces,
            markers,
            link_metadata_items,
            ..
        } = self.edit_context(source, range)?;
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
        let mut rendered = spell(
            pieces,
            guard_state,
            super::typed_angle::TypedState::current(typed_inputs),
            &raw,
            markers,
            end..end,
            true,
            &self.references,
        )?;
        if rendered.text == raw {
            return Ok(None);
        }
        let delimiter_work = rendered.relocate_delimiters(source_start);
        let prefix = common_prefix(&raw, &rendered.text);
        let suffix: usize = raw[prefix..]
            .chars()
            .rev()
            .zip(rendered.text[prefix..].chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(ch, _)| ch.len_utf8())
            .sum();
        Ok(Some(Plan {
            retained: Default::default(),
            requires_source_identity: false,
            guarded_words: rendered.take_guards(source_start, source_end),
            split_retirement: None,
            pending_links: rendered.pending_links,
            activated_links: rendered.activated_links,
            delimiters: rendered.delimiters,
            input_start: 0,
            range: source_start + prefix..source_end - suffix,
            inserted: rendered.text[prefix..rendered.text.len() - suffix].to_owned(),
            caret: source_start,
            formats: Vec::new(),
            materialized: raw.len() + rendered.text.len() + rendered.materialized,
            parsed: rendered.parsed,
            link_metadata_items: link_metadata_items
                + delimiter_work
                + rendered.link_metadata_items,
            link_copied_bytes: rendered.link_copied_bytes,
        }))
    }
}
