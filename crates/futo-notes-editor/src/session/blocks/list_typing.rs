//! Pinned list shortcuts; source spelling before the trigger remains undoable.
use super::*;

/// A typed list marker: `None` for a bullet, else the ordered start.
fn typed_marker(prefix: &str) -> Option<Option<u64>> {
    if matches!(prefix, "- " | "+ " | "* ") {
        return Some(None);
    }
    prefix
        .strip_suffix(". ")
        .filter(|s| !s.is_empty() && s.len() <= 9 && s.bytes().all(|b| b.is_ascii_digit()))
        .map(|number| Some(number.parse::<u64>().unwrap()))
}

impl EditorSession {
    pub(super) fn list_conversion(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        prefix: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let line = self.projection.block_lines(range).remove(0);
        let (start, task, retype) = if line.list.is_some() {
            if line.task.is_none() && matches!(prefix, "[ ] " | "[x] ") {
                (None, Some(prefix == "[x] "), false)
            } else if let Some(start) = typed_marker(prefix)
                .filter(|_| range.start.0 == self.projection.display_at(line.content.end))
            {
                // A marker typed into an empty item changes that item's kind.
                (start, None, true)
            } else {
                return Ok(None);
            }
        } else if let Some(start) = typed_marker(prefix.trim_start_matches([' ', '\t'])) {
            (start, None, false)
        } else {
            return Ok(None);
        };
        let (caret, _) = self
            .projection
            .source_selection(range, self.input_affinity(range));
        let typed = caret.start.source.0;
        if retype {
            return self.retype_empty_item(expected, range, start, typed, accept);
        }
        self.list_shortcut(expected, range, start, task, typed, accept)
    }
}
