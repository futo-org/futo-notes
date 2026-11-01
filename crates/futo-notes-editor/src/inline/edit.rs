//! Local marker surgery. Visible pieces retain their original source spelling
//! and span identity; only spans that lose content or cross the edited range
//! move. The parser remains the authority for interpreting candidate source.
mod carry;
mod context;
mod prefixes;
pub(super) use context::Context;
mod selection;
mod source;
use super::row::SpanKind;
use super::{
    spelling::{spell, Marker, Piece, PieceOrigin},
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
    pub guarded_words: Option<super::guarded_words::GuardUpdate>,
    pub split_retirement: Option<std::sync::Arc<super::guarded_words::CodeWordIdentity>>,
    pub retained: SourceCorrespondence,
    pub requires_source_identity: bool,
    pub range: Range<usize>,
    pub delimiters: Vec<Range<usize>>,
    pub pending_links: Vec<Range<usize>>,
    pub activated_links: Vec<Range<usize>>,
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
        mut range: DisplayRange,
        inserted: &str,
        affinity: Affinity,
        pending: Option<&[InlineFormat]>,
        intent: EditIntent,
    ) -> Result<Plan, EditorError> {
        // Front matter is inert: input within it rejects, and input covering
        // it changes only the body.
        let body = self.body_start();
        if range.end.0 < body {
            return Err(EditorError::InvalidRange);
        }
        range.start.0 = range.start.0.max(body);
        let toggle = match intent {
            EditIntent::Toggle(format) => Some(format),
            _ => None,
        };
        let Context {
            typed_inputs,
            mut guard_state,
            raw,
            source_start,
            source_end,
            a,
            z,
            mut markers,
            pieces,
            block_boundaries,
            pending_links,
            link_metadata_items,
        } = self.edit_context_for_change(source, range, toggle.is_none().then_some(inserted))?;
        let mut typed = super::typed_angle::TypedState::current(typed_inputs);
        let expanded = split_entities(pieces, a, z);
        let (split_guard, split_work) =
            guard_state.prepare_split(&expanded, a..z, inserted, intent)?;
        let (deleting_guard, deletion_proof_work) =
            guard_state.prove_deletion(&expanded, &markers, a..z, inserted, intent)?;
        let mut guard_work = super::references::ReferenceWork::default();
        guard_work.items += deletion_proof_work + split_work;
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
        changed.extend(inserted.char_indices().map(|(offset, ch)| Piece {
            guard: split_guard.map(|id| super::guarded_words::GuardPart {
                id,
                role: super::guarded_words::GuardRole::Inner,
            }),
            physical_prefix: false,
            literal_url: None,
            raw: ch.to_string(),
            display: ch.to_string(),
            spans: active.clone(),
            trailing: false,
            definition: None,
            origin: Some(PieceOrigin::Inserted(offset..offset + ch.len_utf8())),
            timing: false,
        }));
        let insertion_end = changed.len();
        changed.extend(after);
        if let Some(owner) = deleting_guard {
            let work = guard_state.finish_deletion(&changed, owner)?;
            guard_work.items += work.items;
            guard_work.copied += work.copied;
            guard_work.parsed += work.parsed;
        }
        let typed_work = typed.prepare_input(
            super::typed_angle::Input {
                projection: self,
                source_start,
                range,
                inserted,
                intent,
                insertion: insertion_index..insertion_end,
            },
            &mut changed,
            &mut markers,
        )?;
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
        let mut toggle_work = 0;
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
            toggle_work = super::toggle::pieces(&mut changed, &mut markers, a..z, format, &opaque);
            if format == InlineFormat::Code {
                let work = guard_state.enroll(&mut changed, &markers)?;
                guard_work.items += work.items;
                guard_work.copied += work.copied;
                guard_work.parsed += work.parsed;
            }
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
        let completion = super::links::complete_typed_angle(
            &mut changed,
            &mut markers,
            insertion_index..insertion_end,
            inserted,
            intent,
            &pending_links,
        );
        let angle = super::links::finish_angle_word(
            &mut changed,
            &mut markers,
            &mut guard_state,
            insertion_index,
            inserted,
        );
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
            guard_state,
            typed,
            &raw,
            markers,
            insertion_index..insertion_end,
            literal,
            &self.references,
        )?;
        let delimiter_work = rendered.relocate_delimiters(source_start);
        let parsed = rendered.parsed + angle.work.parsed + completion.work.parsed;
        let guarded_words = rendered.take_guards(source_start, source_end);
        let output = rendered.text;
        let caret = rendered.caret;
        let (mut retained, mut correspondence_work) =
            SourceCorrespondence::verify(&raw, inserted, &output, rendered.origins, source_start);
        if let Some(word) = angle.source {
            correspondence_work +=
                retained.retire_word(source_start + word.start..source_start + word.end);
        }
        let prefix = common_prefix(&raw, &output);
        let suffix: usize = raw[prefix..]
            .chars()
            .rev()
            .zip(output[prefix..].chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(c, _)| c.len_utf8())
            .sum();
        Ok(Plan {
            guarded_words,
            split_retirement: rendered.split_retirement,
            retained,
            requires_source_identity: !literal,
            pending_links: rendered.pending_links,
            activated_links: rendered.activated_links,
            delimiters: rendered.delimiters,
            range: source_start + prefix..source_end - suffix,
            inserted: output[prefix..output.len() - suffix].to_owned(),
            caret: source_start + caret,
            input_start: source_start + rendered.input_start,
            formats,
            materialized: raw.len()
                + output.len()
                + timing.materialized
                + angle.materialized
                + completion.materialized
                + rendered.materialized,
            parsed: parsed + timing.work.parsed + guard_work.parsed + typed_work.parsed,
            link_metadata_items: typed_work.items
                + guard_work.items
                + link_metadata_items
                + delimiter_work
                + correspondence_work
                + timing.work.items
                + rendered.link_metadata_items
                + angle.work.items
                + completion.work.items
                + toggle_work,
            link_copied_bytes: typed_work.copied
                + guard_work.copied
                + rendered.link_copied_bytes
                + angle.work.copied
                + completion.work.copied
                + timing.work.copied,
        })
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
