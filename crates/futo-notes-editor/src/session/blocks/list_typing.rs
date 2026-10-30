//! Pinned list shortcuts; source spelling before the trigger remains undoable.
use super::*;

impl EditorSession {
    pub(super) fn list_conversion(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        prefix: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let line = self.projection.block_lines(range).remove(0);
        let marker = if let Some(list) = &line.list {
            if list.checked.is_none() && matches!(prefix, "[ ] " | "[x] ") {
                prefix.to_owned()
            } else {
                return Ok(None);
            }
        } else {
            let trimmed = prefix.trim_start_matches([' ', '\t']);
            if matches!(trimmed, "- " | "+ " | "* ") {
                "- ".into()
            } else if let Some(number) = trimmed
                .strip_suffix(". ")
                .filter(|s| !s.is_empty() && s.len() <= 9 && s.bytes().all(|b| b.is_ascii_digit()))
            {
                format!("{}. ", number.parse::<u64>().unwrap())
            } else {
                return Ok(None);
            }
        };
        self.stage_block_action(expected, range, None, accept, |staged, local, accept| {
            let line = staged.projection.block_lines(local).remove(0);
            let start = DisplayOffset(staged.projection.display_at(line.content.start));
            let removed = staged.replace_action(
                staged.revision(),
                DisplayRange {
                    start,
                    end: local.start,
                },
                "",
                crate::InputAction::Isolated,
                accept,
            )?;
            let line = staged.projection.block_lines(staged.selection()).remove(0);
            let at = line.content.start;
            let mut output = staged.source.byte_slice(line.source.clone()).to_string();
            output.insert_str(at - line.source.start, &marker);
            let mut before = String::new();
            if line.list.is_none() && marker.ends_with(". ") && marker != "1. " {
                let index = staged.source.byte_to_line(line.source.start);
                if index > 0 {
                    let previous = staged.source.line_to_byte(index - 1);
                    let point = DisplayOffset(staged.projection.display_at(previous));
                    if staged
                        .projection
                        .block_lines(DisplayRange {
                            start: point,
                            end: point,
                        })
                        .first()
                        .is_some_and(|previous| {
                            !previous.content.is_empty()
                                && previous.heading == 0
                                && !previous.code
                                && !previous.divider
                                && previous.list.is_none()
                                && previous.quote_depth == line.quote_depth
                        })
                    {
                        let prefix = staged
                            .source
                            .byte_slice(line.source.start..line.content.start)
                            .to_string();
                        before = format!("{}\n", prefix.trim_end_matches([' ', '\t']));
                        output.insert_str(0, &before);
                    }
                }
            }
            if line.list.is_none() {
                if let Some(separator) =
                    staged.list_neighbor_separator(line.source.end, line.quote_depth)
                {
                    output.push_str(&separator);
                }
            }
            let formats = staged.pending_formats.clone();
            let affinity = staged.affinity;
            let mut change = staged.commit_block_edit(
                staged.revision(),
                line.source.clone(),
                &output,
                BlockSelection::Source(at + marker.len() + before.len()),
                None,
                accept,
            )?;
            staged.carry_block_state(&mut change, formats, affinity);
            change.work.materialized_source_bytes += removed.work.materialized_source_bytes;
            change.work.parsed_source_bytes += removed.work.parsed_source_bytes;
            Ok(Some(change))
        })
    }
}
