//! Joining two items and normalizing their surviving ordered list is one action.
use super::*;

impl EditorSession {
    pub(super) fn join_list_key(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        key: ParagraphKey,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if range.start != range.end
            || !matches!(key, ParagraphKey::Backspace | ParagraphKey::Delete)
        {
            return Ok(None);
        }
        let Some(line) = self.projection.block_lines(range).into_iter().next() else {
            return Ok(None);
        };
        let Some(list) = &line.list else {
            return Ok(None);
        };
        if line.code {
            return Ok(None);
        }
        let index = self.source.byte_to_line(line.source.start);
        let (neighbor, backwards) = if key == ParagraphKey::Backspace
            && list.first
            && range.start.0 == self.projection.display_at(line.content.start)
            && index > 0
        {
            (self.source.line_to_byte(index - 1), true)
        } else if key == ParagraphKey::Delete
            && range.start.0 == self.projection.display_at(line.content.end)
            && line.source.end < self.source.len_bytes()
        {
            (line.source.end, false)
        } else {
            return Ok(None);
        };
        let point = DisplayOffset(self.projection.display_at(neighbor));
        let Some(other) = self
            .projection
            .block_lines(DisplayRange {
                start: point,
                end: point,
            })
            .into_iter()
            .next()
        else {
            return Ok(None);
        };
        if other.code
            || other
                .list
                .as_ref()
                .is_none_or(|other| other.owner != list.owner || other.item == list.item)
        {
            return Ok(None);
        }
        let join = if backwards {
            DisplayRange {
                start: DisplayOffset(self.projection.display_at(other.content.end)),
                end: range.start,
            }
        } else {
            DisplayRange {
                start: range.start,
                end: DisplayOffset(self.projection.display_at(other.content.start)),
            }
        };
        self.stage_block_action(expected, range, None, accept, |staged, local, accept| {
            let base = range.start.0 - local.start.0;
            let join = DisplayRange {
                start: DisplayOffset(join.start.0 - base),
                end: DisplayOffset(join.end.0 - base),
            };
            staged.selection = join;
            let mut change = staged.replace_action(
                staged.revision(),
                join,
                "",
                crate::InputAction::Isolated,
                accept,
            )?;
            if let Some(normalized) = staged.normalize_list_numbers(accept)? {
                change.work.materialized_source_bytes += normalized.work.materialized_source_bytes;
                change.work.parsed_source_bytes += normalized.work.parsed_source_bytes;
            }
            Ok(Some(change))
        })
    }

    fn normalize_list_numbers(
        &mut self,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let Some(line) = self
            .projection
            .block_lines(self.selection)
            .into_iter()
            .next()
        else {
            return Ok(None);
        };
        let Some(list) = &line.list else {
            return Ok(None);
        };
        if list.ordinal.is_none() {
            return Ok(None);
        }
        let group = DisplayRange {
            start: DisplayOffset(self.projection.display_at(list.owner.start)),
            end: DisplayOffset(self.projection.display_at(list.owner.end)),
        };
        let mut output = self.source.byte_slice(list.owner.clone()).to_string();
        let mut changed = false;
        for line in self.projection.block_lines(group).into_iter().rev() {
            let Some(item) = line.list else {
                continue;
            };
            if !item.first || item.owner != list.owner {
                continue;
            }
            let number = item.ordinal.unwrap();
            let digits = item.marker.start..item.marker.end - 1;
            let replacement = super::lists::physical_number(number).to_string();
            if self.source.byte_slice(digits.clone()).to_string() != replacement {
                output.replace_range(
                    digits.start - list.owner.start..digits.end - list.owner.start,
                    &replacement,
                );
                changed = true;
            }
        }
        if !changed {
            return Ok(None);
        }
        let formats = self.pending_formats.clone();
        let affinity = self.affinity;
        let mut change = self.commit_block_edit(
            self.revision(),
            list.owner.clone(),
            &output,
            BlockSelection::Display(self.selection),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        Ok(Some(change))
    }
}
