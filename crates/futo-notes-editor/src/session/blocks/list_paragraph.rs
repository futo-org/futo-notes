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
            let quote_end = prefix.rfind('>').map_or(0, |at| {
                at + 1 + usize::from(matches!(prefix.as_bytes().get(at + 1), Some(b' ' | b'\t')))
            });
            let formats = (range == self.selection)
                .then(|| self.pending_formats.clone())
                .flatten();
            let affinity = self.input_affinity(range);
            let list = line.list.as_ref().unwrap();
            let group = DisplayRange {
                start: DisplayOffset(self.projection.display_at(list.owner.start)),
                end: DisplayOffset(self.projection.display_at(list.owner.end)),
            };
            let members = self.projection.block_lines(group);
            let before = members.iter().any(|other| {
                other.list.as_ref().is_some_and(|item| {
                    item.owner == list.owner && item.marker.start < list.marker.start
                })
            });
            let after = members.iter().any(|other| {
                other.list.as_ref().is_some_and(|item| {
                    item.owner == list.owner && item.marker.start > list.marker.start
                })
            });
            let mut replacement = prefix[..quote_end].to_owned();
            let end = if before && after {
                // Blank lines alone leave both halves in one loose CommonMark
                // list. Keep this exited blank line and persist the boundary.
                replacement.push_str(
                    &self
                        .source
                        .byte_slice(line.content.end..line.source.end)
                        .to_string(),
                );
                replacement.push_str(&prefix[..quote_end]);
                replacement.push_str("<!-- -->\n");
                line.source.end
            } else {
                line.content.start
            };
            let mut change = self.commit_block_edit(
                expected,
                line.source.start..end,
                &replacement,
                BlockSelection::Display(range),
                None,
                accept,
            )?;
            self.carry_block_state(&mut change, formats, affinity);
            return Ok(Some(change));
        }
        let list = line.list.as_ref().unwrap();
        let at_start = range.start.0 == self.projection.display_at(line.content.start);
        if list.first && line.task.is_none() && at_start {
            return self
                .commit_block_key(
                    expected,
                    range,
                    line.source.start..line.source.start,
                    "\n",
                    line.source.start + 1,
                    accept,
                )
                .map(Some);
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
}
