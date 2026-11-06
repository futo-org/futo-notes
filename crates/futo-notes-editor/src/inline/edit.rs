//! Local marker surgery. Visible pieces retain their original source spelling
//! and span identity; only spans that lose content or cross the edited range
//! move. The parser remains the authority for interpreting candidate source.
mod carry;
mod context;
mod prefixes;
pub(super) use context::Context;
mod selection;
mod source;
mod span_sweep;
use super::row::SpanKind;
use super::{
    spelling::{spell, Marker, Piece, PieceOrigin},
    Projection,
};
use crate::{Affinity, DisplayRange, EditorError, InlineFormat};
pub(super) use carry::{carry_formats, joined_span};
use ropey::Rope;
pub(super) use selection::{cut, split_entities, Cut};
pub(crate) use source::SourceCorrespondence;
use std::ops::Range;

#[derive(Clone, Copy)]
pub(crate) enum EditIntent {
    Input(crate::InputAction),
    /// A selected format toggle. `Some(add)` forces its direction, the one a
    /// multi-block selection decided for all of its bodies; `None` decides
    /// from the selected pieces alone.
    Toggle(InlineFormat, Option<bool>),
}

/// How far an input's planning context reaches.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Width {
    /// The rows holding the edited range.
    Rows,
    /// Those rows and the next one, which text typed on the blank line
    /// ending them joins.
    Joined,
    /// Those rows widened to whole physical lines past word seams.
    Line,
    /// The complete paragraph or list.
    Paragraph,
}

pub(crate) struct Plan {
    pub guarded_words: Option<super::guarded_words::GuardUpdate>,
    pub split_retirement: Option<std::sync::Arc<super::guarded_words::CodeWordIdentity>>,
    pub retained: SourceCorrespondence,
    pub requires_source_identity: bool,
    /// The source window the planner read; `range` lies inside it.
    pub context: Range<usize>,
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
        range: DisplayRange,
        inserted: &str,
        affinity: Affinity,
        pending: Option<&[InlineFormat]>,
        intent: EditIntent,
    ) -> Result<Plan, EditorError> {
        self.edit_cell(source, range, inserted, affinity, pending, intent, false)
    }

    /// `escape_pipes` spells every inserted `|` as `\|`, the only spelling a
    /// GFM table cell can hold; display text stays a literal pipe.
    #[allow(clippy::too_many_arguments)]
    pub fn edit_cell(
        &self,
        source: &Rope,
        range: DisplayRange,
        inserted: &str,
        affinity: Affinity,
        pending: Option<&[InlineFormat]>,
        intent: EditIntent,
        escape_pipes: bool,
    ) -> Result<Plan, EditorError> {
        let plan = |width, reuse| {
            self.edit_in(
                source,
                range,
                inserted,
                affinity,
                pending,
                intent,
                escape_pipes,
                width,
                reuse,
            )
        };
        // A cut context can be too narrow to plan (or to judge) the input:
        // plan once more against the whole line when a word seam bounds the
        // rows, then against the complete paragraph or list (#314).
        let mut tried = Vec::new();
        // Text typed on a blank line joins the paragraph below it, whose
        // delimiters can then pair with the typed text or the row's own. Plan
        // it with that paragraph first, so delimiters stay raw only while the
        // joined paragraph reads as typed; when it cannot be planned, a typed
        // delimiter lands escaped as literal text.
        let _escape = if matches!(intent, EditIntent::Input(_))
            && !inserted.is_empty()
            && self.joins_next_row(range)
        {
            match plan(Width::Joined, true) {
                Ok((plan, true)) => return Ok(spent(plan, tried)),
                Ok((plan, false)) => tried.push(plan),
                Err(_) => {}
            }
            inserted
                .contains(['*', '_', '~', '`'])
                .then(super::spelling::EscapeTypedDelimiters::set)
        } else {
            None
        };
        let mut widths = vec![Width::Rows];
        if self.at_word_seam(range) {
            widths.push(Width::Line);
        }
        for width in widths {
            match plan(width, true) {
                Ok((plan, true)) => return Ok(spent(plan, tried)),
                Ok((plan, false)) => tried.push(plan),
                Err(_) => {}
            }
        }
        // Carried formats join the span beside them where they can. When that
        // reading cannot be spelled (a format dropped around trailing
        // whitespace), the new text opens spans of its own.
        let (wide, _) = match plan(Width::Paragraph, true) {
            Err(EditorError::UnrepresentableFormat) if pending.is_some() => {
                plan(Width::Paragraph, false)?
            }
            other => other?,
        };
        Ok(spent(wide, tried))
    }

    #[allow(clippy::too_many_arguments)]
    fn edit_in(
        &self,
        source: &Rope,
        mut range: DisplayRange,
        inserted: &str,
        affinity: Affinity,
        pending: Option<&[InlineFormat]>,
        intent: EditIntent,
        escape_pipes: bool,
        width: Width,
        reuse: bool,
    ) -> Result<(Plan, bool), EditorError> {
        // Front matter is inert: input within it rejects, and input covering
        // it changes only the body.
        let body = self.body_start();
        if range.end.0 < body {
            return Err(EditorError::InvalidRange);
        }
        range.start.0 = range.start.0.max(body);
        let (toggle, direction) = match intent {
            EditIntent::Toggle(format, direction) => (Some(format), direction),
            _ => (None, None),
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
        } = self.edit_context_for_change(
            source,
            range,
            toggle.is_none().then_some(inserted),
            width,
        )?;
        let following = self.rows.locate(source_end, false);
        let continued = source_end < source.len_bytes() && {
            let (row, at, _) = self.rows.at(following);
            at == source_end && row.continues && row.opener.is_some()
        };
        let first_row = self.rows.at(self.rows.locate(source_start, false)).0;
        let _opener = super::row::CandidateOpener::set((
            first_row.opener.clone(),
            continued,
            source_end < source.len_bytes(),
            first_row.context.clone(),
        ));
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
            left.clone()
        } else {
            right.clone()
        };
        if let Some(formats) = pending {
            carry_formats(
                &mut before,
                &after,
                &mut markers,
                &mut active,
                formats,
                reuse,
            );
        }
        // A pasted span joins the same style beside it; typed text, even a
        // committed string, lands character for character.
        let typing = matches!(intent, EditIntent::Input(crate::InputAction::Typing));
        let joined = if toggle.is_none() && !typing {
            joined_span(inserted, &markers, [&active, &left, &right])
        } else {
            None
        };
        let (kept, inserted_spans) = match &joined {
            Some((id, kept)) => {
                let mut spans = active.clone();
                if !spans.contains(id) {
                    spans.insert(0, *id);
                }
                (kept.clone(), spans)
            }
            None => (0..inserted.len(), active.clone()),
        };
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
        let pieces = inserted.char_indices().filter(|(at, _)| kept.contains(at));
        changed.extend(pieces.map(|(offset, ch)| Piece {
            guard: split_guard.map(|id| super::guarded_words::GuardPart {
                id,
                role: super::guarded_words::GuardRole::Inner,
            }),
            physical_prefix: false,
            literal_url: None,
            raw: if escape_pipes && ch == '|' {
                "\\|".to_owned()
            } else {
                ch.to_string()
            },
            display: ch.to_string(),
            spans: inserted_spans.clone(),
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
                    Some(boundary - (z - a) + kept.len())
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
            toggle_work =
                super::toggle::pieces(&mut changed, &mut markers, a..z, format, direction, &opaque);
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
                // Indentation before a marker still leaves it a block marker.
                .all(|ch| matches!(ch, '#' | '>' | '*' | '_' | ' ' | '\t'));
        let display_line = self
            .display
            .line_to_byte(self.display.byte_to_line(range.start.0));
        // The line's text before the input, then the input: read lazily, so
        // a caret deep in a long line stops at its first character.
        let prefix = || {
            self.display
                .byte_slice(display_line..range.start.0)
                .chars()
                .chain(inserted.chars())
        };
        let fence = |marker: char| prefix().take(3).filter(|&ch| ch == marker).count() == 3;
        let speculative_fence = (fence('`') || fence('~')) && !prefix().any(char::is_whitespace);
        let mut literal = inserted.contains(['<', '>'])
            || speculative_fence
            || speculative_block
            || toggle.is_some()
            || inserted.is_empty()
            || !inserted[kept.clone()].contains(['*', '_', '~', '`', '\\', '&', '<', '>'])
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
        let (sealed, seal_parsed) =
            self.sealed_candidate(source, source_start, source_end, &output);
        let caret = rendered.caret;
        let literal = rendered.literal;
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
        let plan = Plan {
            context: source_start..source_end,
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
            parsed: parsed
                + seal_parsed
                + timing.work.parsed
                + guard_work.parsed
                + typed_work.parsed,
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
        };
        Ok((plan, sealed))
    }
}

/// `plan` charged with the work of the refused attempts before it.
fn spent(mut plan: Plan, tried: Vec<Plan>) -> Plan {
    for attempt in tried {
        plan.materialized += attempt.materialized;
        plan.parsed += attempt.parsed;
        plan.link_metadata_items += attempt.link_metadata_items;
        plan.link_copied_bytes += attempt.link_copied_bytes;
    }
    plan
}

pub(crate) fn delimiter(format: InlineFormat) -> &'static str {
    match format {
        InlineFormat::Bold => "**",
        InlineFormat::Italic => "*",
        InlineFormat::Strike => "~~",
        InlineFormat::Code => "`",
    }
}
