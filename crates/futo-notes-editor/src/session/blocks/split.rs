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
        let left = super::content::restore_body_prefixes(&left, body.prefixes.iter().skip(1));
        let right = super::content::restore_body_prefixes(
            &right,
            body.prefixes.iter().skip(body.right_line + 1),
        );
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
            // The first slice has one physical line and unchanged spelling on
            // each side. Multiline prefix or marker transformations need their
            // own layout correspondence; never guess it from equal display.
            if body.prefixes.len() == 1 && left == body.left && right == body.right {
                for witness in body.retained {
                    visits += 1;
                    let after = if witness.after.end <= body.split {
                        Some(prefix.len() + witness.after.start..prefix.len() + witness.after.end)
                    } else if witness.after.start >= body.split + 2 {
                        Some(
                            right_start + witness.after.start - body.split - 2
                                ..right_start + witness.after.end - body.split - 2,
                        )
                    } else {
                        None
                    };
                    if let Some(after) = after {
                        retained.push(crate::inline::references::RetainedBody {
                            before: witness.before,
                            after,
                        });
                    }
                }
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
        change.work.materialized_source_bytes += body.materialized + reference_bytes;
        change.work.parsed_source_bytes +=
            body.parsed + left_work + right_work + reference_work.parsed;
        change.work.link_metadata_items += body.link_metadata_items + reference_work.items;
        change.work.link_copied_bytes += body.link_copied_bytes + reference_work.copied;
        Ok(Some(change))
    }
}
