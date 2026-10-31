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
        // Semantic witnesses belong to the original projection. A local stage
        // edge is not a document boundary, even after several blank paragraphs.
        let creating_list = line.list.is_none();
        let styles = creating_list.then(|| {
            self.list_shortcut_styles(
                &line,
                marker
                    .strip_suffix(". ")
                    .map(|number| number.parse().unwrap()),
            )
        });
        let (window, display_origin) = self.projection.edit_window(range);
        let source_anchor = line
            .source
            .start
            .checked_sub(window.start)
            .ok_or(EditorError::InvalidRange)?;
        let display_anchor = self
            .projection
            .display_at(line.content.start)
            .checked_sub(display_origin)
            .ok_or(EditorError::InvalidRange)?;
        let mut styles = styles
            .map(|mut styles| {
                for (position, _) in &mut styles.comments {
                    if *position < window.start || *position > window.end {
                        return Err(EditorError::InvalidRange);
                    }
                    *position -= window.start;
                }
                Ok(styles)
            })
            .transpose()?;
        self.stage_block_action(expected, range, None, accept, |staged, local, accept| {
            let line = staged.projection.block_lines(local).remove(0);
            if line.source.start != source_anchor
                || staged.projection.display_at(line.content.start) != display_anchor
            {
                return Err(EditorError::InvalidRange);
            }
            let formats = staged.pending_formats.clone();
            let affinity = staged.affinity;
            let start = DisplayOffset(staged.projection.display_at(line.content.start));
            let removed = staged.replace_action(
                staged.revision(),
                DisplayRange {
                    start,
                    end: local.start,
                },
                "",
                crate::InputAction::Isolated,
                &mut |edit| {
                    accept(edit)?;
                    if let Some(styles) = &mut styles {
                        // Comments are outside the prefix edit. Map the following
                        // boundary using its exact accepted source-edit anchors.
                        for (position, _) in &mut styles.comments {
                            if *position >= edit.range.end.0 {
                                *position = *position - (edit.range.end.0 - edit.range.start.0)
                                    + edit.inserted.len();
                            }
                        }
                    }
                    Ok(())
                },
            )?;
            let line = staged.projection.block_lines(staged.selection()).remove(0);
            let marker = if let Some(styles) = &styles {
                if let Some(number) = marker.strip_suffix(". ") {
                    format!("{number}{} ", styles.markers[0] as char)
                } else {
                    format!("{} ", styles.markers[0] as char)
                }
            } else {
                marker.clone()
            };
            let at = line.content.start;
            let raw_body = staged.source.byte_slice(line.content.clone()).to_string();
            let (body, body_work) =
                super::list_commands::protect_list_body(&raw_body, marker.starts_with('['));
            let body_bytes = raw_body.len() + body.len();
            let end = styles
                .as_ref()
                .and_then(|styles| styles.comments.iter().map(|(at, _)| *at).max())
                .unwrap_or(0)
                .max(line.source.end);
            let mut output = staged.source.byte_slice(line.source.start..end).to_string();
            output.replace_range(
                line.content.start - line.source.start..line.content.end - line.source.start,
                &body,
            );
            output.insert_str(at - line.source.start, &marker);
            let mut before = String::new();
            if creating_list
                && marker.as_bytes()[0].is_ascii_digit()
                && !marker.starts_with("1.")
                && !marker.starts_with("1)")
            {
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
            let mut separator_bytes = 0;
            if creating_list {
                if let Some((separator, work)) =
                    staged.list_neighbor_separator(end, line.quote_depth)
                {
                    separator_bytes += work;
                    output.push_str(&separator);
                }
            }
            let mut caret = at + marker.len() + before.len();
            if let Some(styles) = styles {
                let shift = output.len() as isize - (end - line.source.start) as isize;
                for (position, comment) in styles.comments.into_iter().rev() {
                    let offset = if position == line.source.start {
                        0
                    } else {
                        (position as isize - line.source.start as isize + shift) as usize
                    };
                    if position <= at {
                        caret += comment.len();
                    }
                    output.insert_str(offset, &comment);
                }
            }
            let mut change = staged.commit_block_edit(
                staged.revision(),
                line.source.start..end,
                &output,
                BlockSelection::Source(caret),
                None,
                accept,
            )?;
            staged.carry_block_state(&mut change, formats, affinity);
            change.work.materialized_source_bytes +=
                removed.work.materialized_source_bytes + body_bytes + separator_bytes;
            change.work.parsed_source_bytes += removed.work.parsed_source_bytes + body_work;
            Ok(Some(change))
        })
    }
}
