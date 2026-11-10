//! Spell a split structural body in its actual final physical layout.
use super::physical_layout::SplitLayout;
use super::*;
use crate::inline::blocks::BlockLine;

impl EditorSession {
    pub(super) fn split_structural_body(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        line: BlockLine,
        prefix: String,
        start_display: usize,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let body = self.split_block_body(std::slice::from_ref(&line), range)?;
        let suffix_range = self.block_line_suffix(&line);
        let suffix_end = suffix_range.end;
        let suffix = self.source.byte_slice(suffix_range).to_string();
        let continuation = if line.quote_depth > 0 {
            "> ".repeat(line.quote_depth)
        } else {
            String::new()
        };
        // A quote continues a line at a time: no blank `>` separator.
        let separator = String::new();
        let setext = line.underline.is_some();
        let left = body.left.as_str();
        // A setext underline must immediately follow nonempty body text. Move
        // the existing terminal body break after that marker, keeping its bytes
        // and visible position relative to the newly inserted LF.
        let heading_end = if setext {
            left.trim_end_matches(['\r', '\n']).len()
        } else {
            left.len()
        };
        let retained_break = &left[heading_end..];
        let (left, left_work) = super::content::protect_content(
            &left[..heading_end],
            line.heading > 0 && !setext,
            setext,
        );
        let (right, right_work) = super::content::protect_content(&body.right, false, true);
        let retain_layout = line.heading > 0
            || body
                .pending
                .as_ref()
                .is_some_and(|pending| pending.has_fields());
        let mut layout_work = 0;
        let (unchanged_left, unchanged_right) = if retain_layout {
            (
                super::physical_layout::same_source(
                    &body.left[..heading_end],
                    &left,
                    &mut layout_work,
                ),
                super::physical_layout::same_source(&body.right, &right, &mut layout_work),
            )
        } else {
            (false, false)
        };
        let left_layout =
            super::content::physical_body(&left, body.prefixes.iter().skip(1), retain_layout);
        let right_layout = super::content::physical_body(
            &right,
            body.prefixes.iter().skip(body.right_line + 1),
            retain_layout,
        );
        let left = &left_layout.text;
        let right = &right_layout.text;
        let mut output =
            format!("{prefix}{left}{suffix}{retained_break}\n{separator}{continuation}{right}");
        let mut caret = line.source.start
            + prefix.len()
            + left.len()
            + suffix.len()
            + retained_break.len()
            + 1
            + separator.len()
            + continuation.len();
        let layout = SplitLayout {
            left: &left_layout,
            right: &right_layout,
            prefix: prefix.len(),
            right_start: caret - line.source.start,
            break_start: prefix.len() + left.len() + suffix.len(),
            heading_end,
            split: body.split,
            unchanged_left,
            unchanged_right,
            setext,
        };
        let (mut retired_atoms, retirement_work) =
            layout.guard_atoms(body.retired_atoms, line.source.start)?;
        layout_work += retirement_work;
        let mut pending = body
            .pending
            .map(|pending| {
                pending.map_copied(0..output.len(), |range| layout.retained_range(range))
            })
            .transpose()?;
        let mut reference_work = crate::inline::references::ReferenceWork::default();
        let mut reference_bytes = 0;
        if line.heading > 0 {
            let right_start = caret - line.source.start;
            let mut retained = Vec::new();
            let mut visits = 0;
            for witness in body.retained {
                visits += 1;
                let (mapped, work) = layout.retained_range(witness.after);
                visits += work;
                if let Some(after) = mapped {
                    retained.push(crate::inline::references::RetainedBody {
                        before: witness.before,
                        after,
                    });
                }
            }
            let (ordered, work) = crate::inline::references::RetainedBody::ordered(&retained);
            visits += work;
            if !ordered {
                return Err(EditorError::UnrepresentableFormat);
            }
            let body_end = self.projection.display_at(line.content.end);
            let expected_display = format!(
                "{}\n{}",
                self.projection
                    .display
                    .byte_slice(start_display..range.start.0),
                self.projection.display.byte_slice(range.end.0..body_end)
            );
            reference_bytes += expected_display.len();
            let regions = [right_start..output.len()];
            (reference_work, reference_bytes) = {
                let (mut work, bytes, prepared_caret) = self.projection.protect_body_definitions(
                    &self.source,
                    self.context.origin.as_ref(),
                    line.source.start..suffix_end,
                    &mut output,
                    &retained,
                    Some(crate::inline::references::BodyIntent {
                        retired_atoms: &mut retired_atoms,
                        display: &expected_display,
                        regions: &regions,
                        caret: right_start,
                        display_caret: range.start.0 + 1 - start_display,
                    }),
                    pending.as_mut(),
                )?;
                caret =
                    line.source.start + prepared_caret.ok_or(EditorError::UnrepresentableFormat)?;
                work.items += visits + 1;
                (work, reference_bytes + bytes)
            };
        }
        if let Some(pending) = &mut pending {
            pending.work += pending.relocate_source(line.source.start);
        }
        let mut change = self.commit_block_with_pending(
            expected,
            line.source.start..suffix_end,
            &output,
            if retired_atoms.is_empty() {
                BlockSelection::Source(caret)
            } else {
                BlockSelection::SourceWithRetiredAtoms {
                    source: caret,
                    atoms: retired_atoms,
                }
            },
            None,
            pending,
            accept,
        )?;
        self.carry_block_state(&mut change, body.formats, body.affinity);
        change.work.materialized_source_bytes +=
            body.materialized + reference_bytes + left_layout.copied + right_layout.copied;
        change.work.parsed_source_bytes +=
            body.parsed + left_work + right_work + reference_work.parsed;
        change.work.link_metadata_items += body.link_metadata_items
            + reference_work.items
            + left_layout.work
            + right_layout.work
            + layout_work;
        change.work.link_copied_bytes += body.link_copied_bytes + reference_work.copied;
        Ok(Some(change))
    }
}
