//! Enter spelling and list numbering after list-key routing chooses insertion.
use super::*;

impl EditorSession {
    pub(super) fn insert_list_paragraph(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        lines: Vec<crate::inline::blocks::BlockLine>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let line = &lines[0];
        let prefix = self
            .source
            .byte_slice(line.source.start..line.content.start)
            .to_string();
        if line.content.is_empty() {
            if line.list.as_ref().is_some_and(|list| {
                list.parent_marker_column.is_some() && line.quote_depth == list.quote_depth
            }) {
                return self.indent_list(expected, range, BlockCommand::Outdent, accept);
            }
            // Leaving a list at its last item: a line written straight under it
            // would join that item as a lazy continuation, so a blank line
            // separates the paragraph the user is about to type.
            let separate = line.quote_depth == 0
                && line.list.as_ref().is_some_and(|list| {
                    list.owner.start < line.source.start && list.owner.end <= line.source.end
                });
            if !separate {
                return self.lift_current_list(expected, range, accept);
            }
            return self.stage_block_action(
                expected,
                range,
                None,
                accept,
                |staged, local, accept| {
                    let Some(lifted) =
                        staged.lift_current_list(staged.revision(), local, accept)?
                    else {
                        return Ok(None);
                    };
                    let caret = staged.selection();
                    let (at, _) = staged.projection.source_bounds(caret.start.0);
                    let mut change = staged.commit_block_key(
                        staged.revision(),
                        caret,
                        at..at,
                        "\n",
                        at + 1,
                        accept,
                    )?;
                    crate::session::transaction::accumulate_planning_work(
                        &mut change.work,
                        lifted.work,
                    );
                    Ok(Some(change))
                },
            );
        }
        let list = line.list.as_ref().unwrap();
        let at_start = range.start.0 == self.projection.display_at(line.content.start);
        if list.first && at_start && range.start == range.end {
            let quote =
                &prefix[..super::indent_source::quote_prefix_end(&prefix, line.quote_depth)];
            return self.enter_at_item_start(expected, range, &format!("{quote}\n"), accept);
        }
        let body = self.split_block_body(&lines, range)?;
        let origin = if list.first {
            line.clone()
        } else {
            let start = self
                .source
                .line_to_byte(self.source.byte_to_line(list.marker.start));
            let point = DisplayOffset(self.projection.display_at(start));
            self.projection
                .block_lines(DisplayRange {
                    start: point,
                    end: point,
                })
                .into_iter()
                .find(|line| {
                    line.list
                        .as_ref()
                        .is_some_and(|item| item.first && item.marker == list.marker)
                })
                .ok_or(EditorError::UnrepresentableFormat)?
        };
        let mut prefix = prefix;
        if list.first {
            if let Some(number) = list.ordinal {
                replace_number(&mut prefix, line, number)?;
            }
        }
        let mut continuation = self
            .source
            .byte_slice(origin.source.start..origin.content.start)
            .to_string();
        if let Some(number) = list.ordinal {
            replace_number(&mut continuation, &origin, number + 1)?;
        }
        let mut left_prefix = prefix.clone();
        if origin.task.is_some() {
            let target = if list.first && at_start {
                &mut left_prefix
            } else {
                &mut continuation
            };
            let at = target.rfind('[').unwrap() + 1;
            target.replace_range(at..at + 1, " ");
        }
        let mut output = format!("{left_prefix}{}\n{continuation}{}", body.left, body.right);
        let mut caret =
            line.source.start + left_prefix.len() + body.left.len() + 1 + continuation.len();
        let mut footprint = line.source.start..line.content.end;
        if list.ordinal.is_some() {
            let group = DisplayRange {
                start: DisplayOffset(self.projection.display_at(list.owner.start)),
                end: DisplayOffset(self.projection.display_at(list.owner.end)),
            };
            footprint =
                line.source.start.min(list.owner.start)..line.content.end.max(list.owner.end);
            let mut raw = self.source.byte_slice(footprint.clone()).to_string();
            let mut edits = vec![(line.source.start..line.content.end, output)];
            for other in self.projection.block_lines(group) {
                let Some(item) = other.list.as_ref() else {
                    continue;
                };
                if !item.first
                    || item.owner != list.owner
                    || item.marker == list.marker && list.first
                {
                    continue;
                }
                let Some(number) = item.ordinal else {
                    continue;
                };
                let number = number + u64::from(item.marker.start > list.marker.start);
                let digits = item.marker.start..item.marker.end - 1;
                let replacement = physical_number(number).to_string();
                if digits.start < line.source.start {
                    caret = caret - digits.len() + replacement.len();
                }
                edits.push((digits, replacement));
            }
            edits.sort_by_key(|(range, _)| range.start);
            for (range, text) in edits.into_iter().rev() {
                raw.replace_range(
                    range.start - footprint.start..range.end - footprint.start,
                    &text,
                );
            }
            output = raw;
        }
        let mut change = self.commit_block_edit(
            expected,
            footprint,
            &output,
            BlockSelection::Source(caret),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, body.formats, body.affinity);
        change.work.materialized_source_bytes += body.materialized;
        change.work.parsed_source_bytes += body.parsed;
        Ok(Some(change))
    }

    /// Enter at a nonempty item's text start: an empty item of the same list
    /// opens above it and the caret stays on the item's text. `blank` (the
    /// item's quote markers and a line break) is staged above the item and the
    /// generic list edit turns it into the new item; both are one Undo step.
    fn enter_at_item_start(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        blank: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.stage_block_action(expected, range, None, accept, |staged, local, accept| {
            let lines = staged.projection.block_lines(local);
            let start = lines
                .first()
                .ok_or(EditorError::UnrepresentableFormat)?
                .source
                .start;
            let caret = start + blank.len() - 1;
            let staged_blank = staged.commit_block_key(
                staged.revision(),
                local,
                start..start,
                blank,
                caret,
                accept,
            )?;
            let Some(mut change) =
                staged.empty_item_above(staged.revision(), staged.selection(), accept)?
            else {
                return Ok(None);
            };
            accumulate_planning_work(&mut change.work, staged_blank.work);
            // The new item's line, then the original text on the next one.
            let display = &staged.projection.display;
            let line = display.byte_to_line(staged.selection().start.0);
            let text = DisplayOffset(display.line_to_byte(line + 1));
            staged.select(
                staged.revision(),
                DisplayRange {
                    start: text,
                    end: text,
                },
            )?;
            Ok(Some(change))
        })
    }
}
