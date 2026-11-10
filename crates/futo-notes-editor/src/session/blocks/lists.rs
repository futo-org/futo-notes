//! List key intent uses the engine's visible body and exact source prefix.
#[path = "list_paragraph.rs"]
mod paragraph;

use super::*;

impl EditorSession {
    pub(super) fn toggle_task(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let Some(line) = self.projection.block_lines(range).into_iter().next() else {
            return Ok(None);
        };
        let Some(task) = line.task.filter(|_| !line.code) else {
            return Ok(None);
        };
        let checked = self
            .source
            .byte_slice(task.start + 1..task.start + 2)
            .to_string();
        let selection = self.selection;
        let formats = self.pending_formats.clone();
        let affinity = self.affinity;
        let mut change = self.commit_block_edit(
            expected,
            task.start + 1..task.start + 2,
            if checked == " " || checked == "\t" {
                "x"
            } else {
                " "
            },
            BlockSelection::Display(selection),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        Ok(Some(change))
    }

    pub(in crate::session) fn list_key(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        key: ParagraphKey,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let lines = self.projection.block_lines(range);
        // A caret touching a hidden fence line also reads two lines; only a
        // selection is deleted first (staging a caret would recurse).
        if matches!(key, ParagraphKey::Enter | ParagraphKey::ShiftEnter)
            && range.start != range.end
            && lines.len() > 1
            && lines.iter().any(|line| line.list.is_some() && !line.code)
        {
            return self.stage_block_action(
                expected,
                range,
                None,
                accept,
                |staged, local, accept| {
                    let removed = staged.replace_action(
                        staged.revision(),
                        local,
                        "",
                        crate::InputAction::Isolated,
                        accept,
                    )?;
                    let Some(mut change) =
                        staged.paragraph_key(staged.revision(), staged.selection(), key, accept)?
                    else {
                        return Ok(None);
                    };
                    change.work.materialized_source_bytes += removed.work.materialized_source_bytes;
                    change.work.parsed_source_bytes += removed.work.parsed_source_bytes;

                    change.work.link_metadata_items += removed.work.link_metadata_items;

                    change.work.link_copied_bytes += removed.work.link_copied_bytes;
                    Ok(Some(change))
                },
            );
        }
        if lines.len() != 1 || lines[0].list.is_none() || lines[0].code {
            return Ok(None);
        }
        if key == ParagraphKey::Backspace
            && range.start == range.end
            && lines[0].list.as_ref().is_some_and(|list| {
                list.first
                    && lines[0].source.contains(&list.marker.start)
                    && list.quote_depth != lines[0].quote_depth
            })
            && range.start.0 == self.projection.display_at(lines[0].content.start)
        {
            // A quote inside a list item is outside the generic list path.
            return Err(EditorError::UnrepresentableFormat);
        }
        if key == ParagraphKey::Backspace && range.start == range.end {
            let line = &lines[0];
            let list = line.list.as_ref().unwrap();
            if list.first
                && list.depth > 1
                && (list.parent_content_column.is_some() || list.previous_content_column.is_some())
                && range.start.0 == self.projection.display_at(line.content.start)
            {
                let column = list
                    .previous_content_column
                    .or(list.parent_content_column)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                let prefix = self
                    .source
                    .byte_slice(line.source.start..line.content.start)
                    .to_string();
                let quote_end = super::indent_source::quote_prefix_end(&prefix, list.quote_depth);
                let base = crate::inline::columns(&prefix[..quote_end], 0);
                let spaces = column
                    .checked_sub(base)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                let replacement = format!("{}{}", &prefix[..quote_end], " ".repeat(spaces));
                return self
                    .commit_block_key(
                        expected,
                        range,
                        line.source.start..line.content.start,
                        &replacement,
                        line.source.start + replacement.len(),
                        accept,
                    )
                    .map(Some);
            }
        }
        if let Some(change) = self.join_list_key(expected, range, key, accept)? {
            return Ok(Some(change));
        }
        if key == ParagraphKey::Backspace
            && range.start == range.end
            && lines[0].list.as_ref().unwrap().first
            && lines[0].list.as_ref().unwrap().item.start
                == lines[0].list.as_ref().unwrap().owner.start
            && range.start.0 == self.projection.display_at(lines[0].content.start)
        {
            return self.lift_current_list(expected, range, accept);
        }
        if !matches!(key, ParagraphKey::Enter | ParagraphKey::ShiftEnter) {
            return Ok(None);
        }
        self.insert_list_paragraph(expected, range, lines, accept)
    }
}

fn replace_number(
    prefix: &mut String,
    line: &crate::inline::blocks::ListCommandLine,
    number: u64,
) -> Result<(), EditorError> {
    let marker = &line.list.as_ref().unwrap().marker;
    let start = marker.start - line.source.start;
    let digits = prefix[start..]
        .bytes()
        .take_while(u8::is_ascii_digit)
        .count();
    prefix.replace_range(start..start + digits, &physical_number(number).to_string());
    Ok(())
}

/// CommonMark limits physical ordered markers to nine digits, while a list's
/// interpreted ordinal may grow beyond that. Lazy `1` remains valid source.
pub(super) fn physical_number(ordinal: u64) -> u64 {
    if ordinal <= 999_999_999 {
        ordinal
    } else {
        1
    }
}
