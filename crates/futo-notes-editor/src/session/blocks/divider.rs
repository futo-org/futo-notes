use super::physical_layout::SplitLayout;
use super::*;
use crate::inline::blocks::BlockLine;

impl EditorSession {
    pub(super) fn insert_divider(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        mut lines: Vec<BlockLine>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let end_point = DisplayRange {
            start: range.end,
            end: range.end,
        };
        if let Some(last) = self.projection.block_lines(end_point).into_iter().next() {
            if last.source.start > lines.last().unwrap().source.start {
                lines.push(last);
            }
        }
        // Code and raw HTML keep `---` literal.
        if lines.iter().any(|line| line.code || line.html) {
            return Ok(None);
        }
        let first = &lines[0];
        let last = lines.last().unwrap();
        let start = first.source.start;
        let last_raw = self.source.byte_slice(last.source.clone()).to_string();
        let end = last.source.start + last_raw.trim_end_matches(['\r', '\n']).len();
        let body = self.split_block_body(&lines, range)?;
        let setext = first.underline.is_some();
        let heading_end = if setext {
            body.left.trim_end_matches(['\r', '\n']).len()
        } else {
            body.left.len()
        };
        let retained_break = &body.left[heading_end..];
        let (left, left_work) = super::content::protect_content(
            &body.left[..heading_end],
            first.heading > 0 && !setext,
            setext || first.heading == 0,
        );
        let (right, right_work) = super::content::protect_content(
            &body.right,
            last.heading > 0 && last.underline.is_none(),
            last.underline.is_some() || last.heading == 0,
        );
        let mut layout_work = 0;
        let retain_fields = body
            .pending
            .as_ref()
            .is_some_and(|pending| pending.has_fields());
        let retain_layout = retain_fields || !body.retained.is_empty();
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
        let protected_bytes = left.len() + right.len();
        let left_layout =
            super::content::physical_body(&left, body.prefixes.iter().skip(1), retain_layout);
        let right_layout = super::content::physical_body(
            &right,
            body.prefixes.iter().skip(body.right_line + 1),
            retain_layout,
        );
        let left = &left_layout.text;
        let right = &right_layout.text;
        let quote = "> ".repeat(first.quote_depth);
        let first_prefix = self
            .source
            .byte_slice(first.source.start..first.content.start)
            .to_string();
        let first_raw = self.source.byte_slice(first.source.clone()).to_string();
        let first_end = first.source.start + first_raw.trim_end_matches(['\r', '\n']).len();
        let first_suffix = self
            .source
            .byte_slice(first.content.end..first_end)
            .to_string();
        let last_prefix = &body.prefixes[body.right_line];
        // A lazy continuation needs an explicit container when it becomes the
        // first body after the new divider boundary.
        let markers = last_prefix
            .bytes()
            .filter(|ch| {
                layout_work += 1;
                *ch == b'>'
            })
            .count();
        let last_prefix = if markers < last.quote_depth {
            let mut prefix = "> ".repeat(last.quote_depth);
            prefix.push_str(last_prefix);
            prefix
        } else {
            last_prefix.clone()
        };
        let last_suffix = self.source.byte_slice(last.content.end..end).to_string();
        let lead = if left.is_empty() {
            String::new()
        } else {
            format!("{first_prefix}{left}{first_suffix}{retained_break}\n")
        };
        let index = self.source.byte_to_line(start);
        let previous_nonempty = index > 0
            && self.source.line(index - 1).chars().any(|ch| {
                layout_work += 1;
                !ch.is_whitespace()
            });
        let marker = if left.is_empty() && !previous_nonempty {
            "---"
        } else {
            "***"
        };
        let mut output = format!("{lead}{quote}{marker}\n{quote}");
        let caret = start + output.len();
        let right_start = if !right.is_empty() {
            output.push('\n');
            output.push_str(&last_prefix);
            let at = output.len();
            output.push_str(right);
            output.push_str(&last_suffix);
            at
        } else {
            output.len()
        };
        let layout = SplitLayout {
            left: &left_layout,
            right: &right_layout,
            prefix: if left.is_empty() {
                0
            } else {
                first_prefix.len()
            },
            right_start,
            break_start: first_prefix.len() + left.len() + first_suffix.len(),
            heading_end,
            split: body.split,
            unchanged_left,
            unchanged_right,
            setext,
        };
        // This is the CURRENT staged snapshot, including Some(empty) after a
        // legitimate word-end retirement. Never restore opening fields here.
        let mut pending = body
            .pending
            .map(|pending| {
                pending.map_copied(0..output.len(), |range| layout.retained_range(range))
            })
            .transpose()?;
        let mut retained = Vec::new();
        for witness in body.retained {
            layout_work += 1;
            let (mapped, visits) = layout.retained_range(witness.after);
            layout_work += visits;
            if let Some(after) = mapped {
                layout_work += 2;
                retained.push(crate::inline::references::RetainedBody {
                    before: witness.before,
                    after,
                });
            }
        }
        let (mut retired_atoms, retirement_work) = layout.guard_atoms(body.retired_atoms, start)?;
        layout_work += retirement_work;
        let (ordered, visits) = crate::inline::references::RetainedBody::ordered(&retained);
        layout_work += visits;
        if !ordered {
            return Err(EditorError::UnrepresentableFormat);
        }
        // The command owns the divider atom and editable paragraph. The old
        // visible side slices retain their intent in this exact physical scope.
        let (display_start, a) = self.projection.display_at_with_work(start);
        let (display_end, z) = self.projection.display_at_with_work(end);
        layout_work += a + z;
        let left_shown = self
            .projection
            .display
            .byte_slice(display_start..range.start.0);
        let right_shown = self.projection.display.byte_slice(range.end.0..display_end);
        let mut intended = String::new();
        if !left.is_empty() {
            intended.extend(left_shown.chars());
            intended.push('\n');
        }
        intended.push('\u{fffc}');
        intended.push('\n');
        let display_caret = intended.len();
        if !right.is_empty() {
            intended.push('\n');
            intended.extend(right_shown.chars());
        }
        let intended_bytes = intended.len();
        let regions = [right_start..output.len()];
        let (reference_work, reference_bytes, prepared_caret) =
            self.projection.protect_body_definitions(
                &self.source,
                self.context.origin.as_ref(),
                start..end,
                &mut output,
                &retained,
                Some(crate::inline::references::BodyIntent {
                    retired_atoms: &mut retired_atoms,
                    display: &intended,
                    regions: &regions,
                    caret: caret - start,
                    display_caret,
                }),
                pending.as_mut(),
            )?;
        layout_work += 1;
        let caret = start + prepared_caret.ok_or(EditorError::UnrepresentableFormat)?;
        if let Some(pending) = &mut pending {
            pending.work += pending.relocate_source(start);
        }
        let mut change = self.commit_block_with_pending(
            expected,
            start..end,
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
        change.work.materialized_source_bytes += body.materialized
            + protected_bytes
            + left_layout.copied
            + right_layout.copied
            + quote.len()
            + first_prefix.len()
            + first_raw.len()
            + last_raw.len()
            + first_suffix.len()
            + last_prefix.len()
            + last_suffix.len()
            + lead.len()
            + output.len()
            + intended_bytes
            + reference_bytes;
        change.work.parsed_source_bytes +=
            body.parsed + left_work + right_work + reference_work.parsed;
        change.work.link_metadata_items += body.link_metadata_items
            + layout_work
            + left_layout.work
            + right_layout.work
            + reference_work.items;
        change.work.link_copied_bytes += body.link_copied_bytes + reference_work.copied;
        Ok(Some(change))
    }
}
