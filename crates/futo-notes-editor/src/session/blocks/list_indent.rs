//! Container indentation uses canonical item ownership and content columns.
use super::*;

impl EditorSession {
    pub(super) fn indent_list(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let lines = self.projection.block_lines(range);
        let Some(first) = lines.first().filter(|line| !line.code) else {
            return Ok(None);
        };
        let Some(item) = &first.list else {
            return Ok(None);
        };
        let Some(column) = item.previous_content_column else {
            return Ok(None);
        };
        let Some(width) = column
            .checked_sub(item.marker_column)
            .filter(|width| *width > 0)
        else {
            return Ok(None);
        };
        let start = self
            .source
            .line_to_byte(self.source.byte_to_line(item.marker.start));
        let end = item.item.end;
        let raw = self.source.byte_slice(start..end).to_string();
        let mut output = String::with_capacity(raw.len() + width);
        for line in raw.split_inclusive('\n') {
            output.push_str(&" ".repeat(width));
            output.push_str(line);
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
