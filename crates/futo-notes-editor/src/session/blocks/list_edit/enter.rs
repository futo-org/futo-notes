//! Enter at a nonempty item's text start, as a generic list edit.
use super::*;

impl EditorSession {
    /// Removing an item's complete body can turn its marker into a setext underline of
    /// its parent. Use the row planner's existing separator repair before accepting it.
    pub(in crate::session) fn empty_list_body(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if range.start == range.end {
            return Ok(None);
        }
        let lines = self.selected_list_lines(range);
        let Some(line) = lines.first().filter(|line| {
            lines.len() == 1
                && !line.code
                && line.heading == 0
                && line.list.as_ref().is_some_and(|list| list.first)
                && self.projection.display_at(line.content.start) == range.start.0
                && self.projection.display_at(line.content.end) == range.end.0
        }) else {
            return Ok(None);
        };
        let start = line.source.start;
        let (window, mut rows) = self.command_rows(range, false);
        let Some(row) = rows.iter_mut().find(|row| row.line.start == start) else {
            return Ok(None);
        };
        row.body = row.body.end..row.body.end;
        row.content = row.body.clone();
        row.forced = true;
        row.from_blank = true;
        self.commit_rows(expected, range, window, rows, accept)
    }

    /// `range` is a caret on a blank row staged directly above an item's
    /// opening row: that row becomes an empty item of the same list (a task
    /// starts unchecked) and the list renumbers around it. Verification and
    /// its repairs apply, so an empty item that cannot interrupt the text
    /// above gets a separating blank line.
    pub(in crate::session::blocks) fn empty_item_above(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (window, mut rows) = self.command_rows(range, true);
        let index = rows
            .iter()
            .position(|row| row.selected)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let item = rows
            .get(index + 1)
            .filter(|item| rows[index].blank && item.before.opens)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let mut chain = item.chain.clone();
        chain.pop();
        chain.push(Some(index));
        let (after, key, start) = (item.after.clone(), item.key, item.before.ordinal);
        let row = &mut rows[index];
        row.after = Shape {
            checked: after.checked.map(|_| false),
            heading: 0,
            inner: 0,
            ..after
        };
        row.key = key;
        row.start = start;
        row.chain = chain;
        row.from_blank = true;
        row.blank = false;
        self.commit_rows(expected, range, window, rows, accept)
    }
}
