//! Indenting an empty list item.
//!
//! An empty item cannot become the first item of a new sub-list: CommonMark
//! lets no empty item interrupt a paragraph, so `- a\n  - ` reads as `a` with
//! a stray `-`, and the list edit could only write it by inserting a blank
//! line. People indent an empty item because they are about to type in it,
//! so the indent waits: the projection reports the item at its new depth
//! (views draw it there), the source is untouched, and the first typed text
//! is written together with the indent as one action. Moving the caret away,
//! Enter, Backspace, Outdent or any other edit unwinds it without a trace.
use super::*;
use crate::BlockCommand;

#[derive(Debug, Clone)]
pub(super) struct PendingIndent {
    revision: Revision,
    /// Display offset of the empty item's (empty) content.
    display: usize,
    /// Indent presses not written yet.
    levels: usize,
}

impl EditorSession {
    /// The empty list item under a collapsed caret.
    fn empty_item_at(&self, range: DisplayRange) -> Option<usize> {
        if range.start != range.end {
            return None;
        }
        let lines = self.projection.block_lines(range);
        let [line] = lines.as_slice() else {
            return None;
        };
        let at = self.projection.display_at(line.content.start);
        (line.list.is_some() && line.content.is_empty() && !line.code && at == range.start.0)
            .then_some(at)
    }

    fn pending_at(&self, range: DisplayRange) -> Option<PendingIndent> {
        let pending = self.pending_indent.as_ref()?;
        (pending.revision == self.revision && self.empty_item_at(range) == Some(pending.display))
            .then(|| pending.clone())
    }

    /// Report the pending depth in a projection of the current revision.
    pub(super) fn decorate_pending_indent(&self, slice: &mut ProjectionSlice) {
        let Some(pending) = &self.pending_indent else {
            return;
        };
        if pending.revision != slice.revision {
            return;
        }
        for block in &mut slice.blocks {
            if block.range.start.0 == pending.display && block.range.end == block.range.start {
                if let Some(list) = &mut block.list {
                    list.depth += pending.levels;
                }
            }
        }
    }

    /// A display change that only redraws the pending item's line.
    fn pending_view(&self, at: usize) -> ViewChange {
        let point = DisplayRange {
            start: DisplayOffset(at),
            end: DisplayOffset(at),
        };
        let mut projection = self.projection.query(self.revision, point);
        self.decorate_pending_indent(&mut projection);
        ViewChange {
            previous_revision: self.revision,
            revision: self.revision,
            range: point,
            inserted: String::new(),
            selection: self.selection,
            work: EditWork::default(),
            affinity: self.affinity,
            projection,
        }
    }

    fn set_pending(&mut self, at: usize, levels: usize) -> ViewChange {
        self.pending_indent = (levels > 0).then_some(PendingIndent {
            revision: self.revision,
            display: at,
            levels,
        });
        self.pending_view(at)
    }

    /// Indent/Outdent at an empty item; `None` runs the ordinary command.
    pub(super) fn indent_empty_item(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
    ) -> Result<Option<Option<ViewChange>>, EditorError> {
        if self.probing_indent || !matches!(command, BlockCommand::Indent | BlockCommand::Outdent) {
            return Ok(None);
        }
        let Some(at) = self.empty_item_at(range) else {
            return Ok(None);
        };
        if let Some(pending) = self.pending_at(range) {
            let levels = match command {
                BlockCommand::Indent => pending.levels + 1,
                _ => pending.levels - 1,
            };
            return Ok(Some(Some(self.set_pending(at, levels))));
        }
        if command != BlockCommand::Indent {
            return Ok(None);
        }
        // Ask the ordinary command what it would write, refusing the edit
        // (a refused acceptance leaves the session unchanged).
        let mut planned: Option<SourceEdit> = None;
        self.probing_indent = true;
        let probe = self.block_command(expected, range, command, &mut |edit| {
            planned = Some(edit.clone());
            Err("probe".into())
        });
        self.probing_indent = false;
        let adds_line = planned.as_ref().is_some_and(|edit| {
            let removed = self
                .source
                .byte_slice(edit.range.start.0..edit.range.end.0)
                .to_string();
            edit.inserted.matches('\n').count() > removed.matches('\n').count()
        });
        match probe {
            Err(EditorError::Persistence(_)) if !adds_line => Ok(None),
            Err(EditorError::Persistence(_)) | Err(EditorError::UnrepresentableFormat) => {
                Ok(Some(Some(self.set_pending(at, 1))))
            }
            _ => Ok(None),
        }
    }

    /// Enter, Backspace and Shift+Tab unwind a pending indent; Tab adds one.
    pub(super) fn pending_indent_key(
        &mut self,
        range: DisplayRange,
        key: crate::ParagraphKey,
    ) -> Option<ViewChange> {
        use crate::ParagraphKey::*;
        let pending = self.pending_at(range)?;
        let levels = match key {
            Enter => 0,
            Backspace | ShiftTab => pending.levels - 1,
            Tab => pending.levels + 1,
            _ => return None,
        };
        Some(self.set_pending(pending.display, levels))
    }

    /// Typing into a pending item writes the text, then the indent, as one action.
    pub(super) fn type_into_pending_indent(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if inserted.is_empty() || inserted.contains(['\n', '\r']) {
            return Ok(None);
        }
        let Some(pending) = self.pending_at(range) else {
            return Ok(None);
        };
        self.pending_indent = None;
        self.stage_block_action(expected, range, None, accept, |staged, local, accept| {
            let mut change =
                staged.replace_action(staged.revision(), local, inserted, action, accept)?;
            for _ in 0..pending.levels {
                let caret = staged.selection();
                // Text first, then the indent the list can now write; one that
                // still cannot be written leaves the text where it is.
                match staged.block_command(staged.revision(), caret, BlockCommand::Indent, accept) {
                    Ok(Some(next)) => {
                        let mut next = next;
                        transaction::accumulate_planning_work(&mut next.work, change.work);
                        change = next;
                    }
                    _ => break,
                }
            }
            Ok(Some(change))
        })
    }
}
