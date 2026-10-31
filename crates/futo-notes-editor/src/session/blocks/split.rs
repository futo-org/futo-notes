//! Spell a split structural body in its actual final physical layout.
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
        let suffix_end = line.source.start
            + self
                .source
                .byte_slice(line.source.clone())
                .to_string()
                .trim_end_matches(['\r', '\n'])
                .len();
        let suffix = self
            .source
            .byte_slice(line.content.end..suffix_end)
            .to_string();
        let continuation = if line.quote_depth > 0 {
            "> ".repeat(line.quote_depth)
        } else {
            String::new()
        };
        let separator = if line.quote_depth > 0 && line.heading == 0 {
            format!("{}\n", continuation.trim_end())
        } else {
            String::new()
        };
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
        let unchanged_left = left == body.left[..heading_end];
        let unchanged_right = right == body.right;
        let left_layout =
            super::content::physical_body(&left, body.prefixes.iter().skip(1), line.heading > 0);
        let right_layout = super::content::physical_body(
            &right,
            body.prefixes.iter().skip(body.right_line + 1),
            line.heading > 0,
        );
        let left = &left_layout.text;
        let right = &right_layout.text;
        let mut output =
            format!("{prefix}{left}{suffix}{retained_break}\n{separator}{continuation}{right}");
        let caret = line.source.start
            + prefix.len()
            + left.len()
            + suffix.len()
            + retained_break.len()
            + 1
            + separator.len()
            + continuation.len();
        let mut reference_work = crate::inline::references::ReferenceWork::default();
        let mut reference_bytes = 0;
        if line.heading > 0 {
            let right_start = caret - line.source.start;
            let mut retained = Vec::new();
            let mut visits = 0;
            for witness in body.retained {
                visits += 1;
                let mapped = if unchanged_left && witness.after.end <= heading_end {
                    let (range, work) = left_layout.retained_range(witness.after.clone());
                    visits += work;
                    range.map(|range| prefix.len() + range.start..prefix.len() + range.end)
                } else if setext
                    && witness.after.start >= heading_end
                    && witness.after.end <= body.split
                {
                    // This retained terminal break is emitted AFTER the exact
                    // setext suffix. Its old body identity does not move through
                    // an inferred visible offset.
                    let at = prefix.len() + left.len() + suffix.len();
                    Some(
                        at + witness.after.start - heading_end
                            ..at + witness.after.end - heading_end,
                    )
                } else if unchanged_right && witness.after.start >= body.split + 2 {
                    let local =
                        witness.after.start - body.split - 2..witness.after.end - body.split - 2;
                    let (range, work) = right_layout.retained_range(local);
                    visits += work;
                    range.map(|range| right_start + range.start..right_start + range.end)
                } else {
                    None
                };
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
                let (mut work, bytes) = self.projection.protect_body_definitions(
                    &self.source,
                    self.context.origin.as_ref(),
                    line.source.start..suffix_end,
                    &mut output,
                    &retained,
                    Some(crate::inline::references::BodyIntent {
                        display: &expected_display,
                        regions: &regions,
                        caret: right_start,
                        display_caret: range.start.0 + 1 - start_display,
                    }),
                )?;
                work.items += visits;
                (work, reference_bytes + bytes)
            };
        }
        let mut change = self.commit_block_edit(
            expected,
            line.source.start..suffix_end,
            &output,
            BlockSelection::Source(caret),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, body.formats, body.affinity);
        change.work.materialized_source_bytes +=
            body.materialized + reference_bytes + left_layout.copied + right_layout.copied;
        change.work.parsed_source_bytes +=
            body.parsed + left_work + right_work + reference_work.parsed;
        change.work.link_metadata_items +=
            body.link_metadata_items + reference_work.items + left_layout.work + right_layout.work;
        change.work.link_copied_bytes += body.link_copied_bytes + reference_work.copied;
        Ok(Some(change))
    }
}
