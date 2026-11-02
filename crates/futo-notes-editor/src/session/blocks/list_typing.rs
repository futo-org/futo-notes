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
        let (start, task) = if line.list.is_some() {
            if line.task.is_none() && matches!(prefix, "[ ] " | "[x] ") {
                (None, Some(prefix == "[x] "))
            } else {
                return Ok(None);
            }
        } else {
            let trimmed = prefix.trim_start_matches([' ', '\t']);
            if matches!(trimmed, "- " | "+ " | "* ") {
                (None, None)
            } else if let Some(number) = trimmed
                .strip_suffix(". ")
                .filter(|s| !s.is_empty() && s.len() <= 9 && s.bytes().all(|b| b.is_ascii_digit()))
            {
                (Some(number.parse::<u64>().unwrap()), None)
            } else {
                return Ok(None);
            }
        };
        let (caret, _) = self
            .projection
            .source_selection(range, self.input_affinity(range));
        self.list_shortcut(expected, range, start, task, caret.start.source.0, accept)
    }
}
