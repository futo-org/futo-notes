//! Plain Markdown copy, cut and paste.
//!
//! Copy exports the selection's exact source, with the marks a selection
//! boundary cuts closed or opened again (`copy.rs`). Cut is copy plus the
//! deletion Backspace makes over the selection, as its own undo step, and
//! carries the cut text's formats to the next typed character. Paste writes
//! the pasted text as it is, behind the one guard (`paste.rs`).
mod copy;
mod paste;

use super::super::command::{Command, Edit};
use super::super::Engine;
use crate::{DisplayRange, EditorError, Revision, SourceEdit, ViewChange};

type Accept<'a> = &'a mut dyn FnMut(&SourceEdit) -> Result<(), String>;

impl Engine {
    /// The selection's Markdown; nothing for a collapsed selection.
    pub(crate) fn copy_markdown(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<String, EditorError> {
        self.check_revision(expected)?;
        self.check_display_range(range)?;
        Ok(self.copied(range))
    }

    /// Copy the selection, then remove it as Backspace over it does, as one
    /// undo step. The formats of the cut text's first character stay carried
    /// for the next typed character.
    pub(crate) fn cut_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: Accept,
    ) -> Result<(String, Option<ViewChange>), EditorError> {
        let mut copied = String::new();
        let mut formats = Vec::new();
        let change = self.run(
            expected,
            |engine| {
                engine.check_display_range(range)?;
                copied = engine.copied(range);
                if copied.is_empty() {
                    return Ok(None);
                }
                let range = engine.outside_crlf(range);
                if engine.touches_metadata(range) {
                    return Err(EditorError::InvalidRange);
                }
                formats = engine.formats_at(engine.source_selection(range).start);
                let plan = engine.plan(range, "");
                let lines = engine.line_of(plan.range.start)..engine.line_of(plan.range.end) + 1;
                let mut command = Command::new(
                    vec![Edit::new(plan.range, plan.inserted)],
                    lines,
                    plan.caret..plan.caret,
                );
                // Removing a selection always lands, as Backspace does.
                command.typed = true;
                Ok(Some(command))
            },
            accept,
        )?;
        let Some(change) = change else {
            return Ok((copied, None));
        };
        // A change with nothing copied only committed marked text.
        if !copied.is_empty() {
            self.formats = Some(formats);
            if let Some(group) = self.history.undo.last_mut() {
                group.after.formats = self.formats.clone();
            }
        }
        let change = self.view(change);
        Ok((copied, Some(change)))
    }

    /// Paste `text` over the selection as one undo step (`paste.rs`).
    pub(crate) fn paste_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        let change = self.run(expected, |engine| engine.paste_command(range, text), accept)?;
        Ok(change.map(|change| self.view(change)))
    }

    /// The inline formats of the character at source offset `at`.
    fn formats_at(&self, at: usize) -> Vec<crate::InlineFormat> {
        let index = self.line_of(at);
        let local = at - self.line_start(index);
        let mut formats: Vec<_> = self
            .line(index)
            .spans
            .iter()
            .filter(|span| span.open.end <= local && local < span.close.start)
            .filter_map(|span| super::super::project::format_of(&span.kind))
            .collect();
        formats.sort();
        formats.dedup();
        formats
    }
}
