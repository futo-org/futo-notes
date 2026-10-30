//! Container indentation uses canonical item ownership and content columns.
use super::*;

impl EditorSession {
    pub(super) fn indent_list(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let lines = self.projection.block_lines(range);
        let Some(first) = lines.first().filter(|line| !line.code) else {
            return Ok(None);
        };
        let Some(item) = &first.list else {
            return Ok(None);
        };
        let (width, add) = if command == BlockCommand::Indent {
            let Some(column) = item.previous_content_column else {
                return Ok(None);
            };
            let Some(width) = column
                .checked_sub(item.marker_column)
                .filter(|width| *width > 0)
            else {
                return Ok(None);
            };
            (width, true)
        } else {
            let Some(column) = item.parent_marker_column else {
                return Ok(None);
            };
            (item.marker_column - column, false)
        };
        let start = self
            .source
            .line_to_byte(self.source.byte_to_line(item.marker.start));
        let end = lines
            .iter()
            .filter_map(|line| line.list.as_ref())
            .filter(|other| other.owner == item.owner)
            .map(|other| other.item.end)
            .max()
            .unwrap_or(item.item.end);
        let raw = self.source.byte_slice(start..end).to_string();
        let mut output = String::with_capacity(raw.len() + width);
        for line in raw.split_inclusive('\n') {
            if add {
                output.push_str(&" ".repeat(width));
                output.push_str(line);
            } else {
                let mut removed = 0;
                let mut bytes = 0;
                for byte in line.bytes() {
                    if removed >= width || !matches!(byte, b' ' | b'\t') {
                        break;
                    }
                    removed += if byte == b'\t' { 4 - removed % 4 } else { 1 };
                    bytes += 1;
                }
                output.push_str(&" ".repeat(removed.saturating_sub(width)));
                output.push_str(&line[bytes..]);
            }
        }
        let formats = (range == self.selection)
            .then(|| self.pending_formats.clone())
            .flatten();
        let affinity = self.input_affinity(range);
        let mut change = self.commit_block_edit(
            expected,
            start..end,
            &output,
            BlockSelection::Display(range),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        change.work.materialized_source_bytes += raw.len();
        Ok(Some(change))
    }
}
