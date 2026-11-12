//! An adopted own-action relink: the store owns the rewrite, the core turns
//! its exact bytes into one command, so one Undo step restores the link
//! text. Existing history is left as it is.
use super::trimmed;
use crate::engine::command::{Command, Edit};
use crate::engine::Engine;
use crate::{EditorError, Revision, SourceEdit, ViewChange};
use similar::{ChangeTag, TextDiff};

impl Engine {
    /// Replace the note's text with the store's `rewritten` bytes. The edits
    /// are the characters that differ, so the selection keeps the bytes the
    /// rewrite left alone and moves out of replaced text to the start of its
    /// replacement. `None` when nothing differs.
    pub(crate) fn apply_own_relink(
        &mut self,
        expected: Revision,
        rewritten: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let original = self.source_text();
        if original == rewritten {
            return Ok(None);
        }
        let window = trimmed(0, &original, rewritten);
        let (start, end) = (window.range.start, window.range.end);
        let mut edits = Vec::new();
        let (mut old, mut new) = (start, 0);
        let mut pending: Option<Edit> = None;
        for change in TextDiff::from_chars(&original[start..end], &window.text).iter_all_changes() {
            let len = change.value().len();
            match change.tag() {
                ChangeTag::Equal => {
                    edits.extend(pending.take());
                    old += len;
                    new += len;
                }
                ChangeTag::Delete => {
                    pending
                        .get_or_insert_with(|| Edit::insert(old, ""))
                        .range
                        .end += len;
                    old += len;
                }
                ChangeTag::Insert => {
                    pending
                        .get_or_insert_with(|| Edit::insert(old, ""))
                        .text
                        .push_str(&window.text[new..new + len]);
                    new += len;
                }
            }
        }
        edits.extend(pending);
        let lines = self.line_of(start)..self.line_of(end) + 1;
        let mut command = Command::new(edits, lines, 0..0);
        let selection = self.source_selection(self.selection);
        command.selection = command.map(selection.start, false)..command.map(selection.end, false);
        command.affinity = Some(self.affinity);
        let change = self.run(expected, |_| Ok(Some(command)), accept)?;
        Ok(change.map(|change| self.view(change)))
    }
}
