//! Drag-to-move: a cut, then a paste at the drop, one Undo step.
use super::super::super::Engine;
use super::Accept;
use crate::{Affinity, DisplayOffset, DisplayRange, EditorError, Revision, ViewChange};

impl Engine {
    /// Move display `range` to display `to` (an offset in the display before the move):
    /// its Markdown cut, then pasted at the drop as a paste there places it, and left
    /// selected. Each half is its own accepted edit; one Undo step undoes both. A drop
    /// inside the selection, or at either of its edges, moves nothing. A paste that
    /// cannot land takes the cut back. Returns the changes in the order they landed.
    pub(crate) fn move_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        to: DisplayOffset,
        accept: Accept,
    ) -> Result<Vec<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        self.check_display_range(range)?;
        self.check_display(to.0)?;
        if range.start.0 <= to.0 && to.0 <= range.end.0 {
            return Ok(Vec::new());
        }
        let (copied, cut) = self.cut_markdown(expected, range, accept)?;
        let Some(cut) = cut else {
            return Ok(Vec::new());
        };
        let cut_depth = self.history.undo.len();
        // The cut's display change may sit beside the selection where the text repeats,
        // so the selection, not the change, says which side the drop is on.
        let removed = cut.range.end.0 - cut.range.start.0;
        let at = if to.0 >= range.end.0 {
            to.0 - removed + cut.inserted.len()
        } else {
            to.0
        };
        let drop = DisplayRange {
            start: DisplayOffset(at),
            end: DisplayOffset(at),
        };
        // The paste lands as one at a clicked caret would, not in the cut's carried formats.
        let pasted = self
            .select(cut.revision, drop)
            .and_then(|_| self.paste_markdown(cut.revision, drop, &copied, accept));
        let Ok(Some(mut pasted)) = pasted else {
            let back = self.history_view(cut.revision, false, accept)?;
            self.history.redo.pop();
            return Ok([Some(cut), back].into_iter().flatten().collect());
        };
        let moved = DisplayRange {
            start: drop.start,
            end: pasted.selection.end,
        };
        if let Ok(selected) = self.select_with_affinity(pasted.revision, moved, Affinity::Forward) {
            pasted.selection = selected.selection;
            pasted.affinity = selected.affinity;
        }
        let after = self.point();
        let paste_groups = self.history.undo.split_off(cut_depth);
        let cut_group = self
            .history
            .undo
            .last_mut()
            .expect("a cut records its Undo step");
        cut_group
            .records
            .extend(paste_groups.into_iter().flat_map(|group| group.records));
        cut_group.after = after;
        Ok(vec![cut, pasted])
    }
}
