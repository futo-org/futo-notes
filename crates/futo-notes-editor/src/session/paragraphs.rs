//! Shared paragraph key intent. The platform supplies its current range; stored
//! selection is history state, never a substitute for that input location.
use super::*;
use crate::{CaretDirection, DisplayUtf16Range, InputAction};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParagraphKey {
    Enter,
    ShiftEnter,
    Backspace,
    Delete,
    Tab,
    ShiftTab,
}

impl EditorSession {
    /// Paragraph Enter/Shift+Enter insert one LF. Directional deletion removes
    /// the selection or one visible extended grapheme (CRLF is one line break).
    /// Headings, quotes and divider edges route through the shared block owner;
    /// Enter in a table cell takes the table's keys; list and fence keys
    /// belong to their subsequent command layer.
    /// Boundary deletion is a no-op with no acceptance, revision or history.
    pub fn paragraph_key(
        &mut self,
        expected: Revision,
        mut range: DisplayRange,
        key: ParagraphKey,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return self.command_during_composition(
                expected,
                range,
                accept,
                |staged, local, accept| staged.paragraph_key(staged.revision(), local, key, accept),
            );
        }
        self.validate_range(range)?;
        range = self.body_range(range)?;
        if matches!(key, ParagraphKey::Tab | ParagraphKey::ShiftTab) {
            return self.fence_tab(expected, range, key == ParagraphKey::ShiftTab, accept);
        }
        if matches!(key, ParagraphKey::Enter | ParagraphKey::ShiftEnter) {
            let shift = key == ParagraphKey::ShiftEnter;
            if let Some(change) = self.cell_enter(expected, range, shift, accept)? {
                return Ok(Some(change));
            }
            if let Some(change) = self.fence_conversion(expected, range, "\n", accept)? {
                return Ok(Some(change));
            }
        }
        if let Some(change) = self.list_key(expected, range, key, accept)? {
            return Ok(Some(change));
        }
        if let Some(change) = self.structural_key(expected, range, key, accept)? {
            return Ok(Some(change));
        }
        let stop = |position, direction| self.grapheme_stop(position, direction, false);
        let inserted = match key {
            ParagraphKey::Tab | ParagraphKey::ShiftTab => unreachable!(),
            ParagraphKey::Enter | ParagraphKey::ShiftEnter => "\n",
            ParagraphKey::Backspace | ParagraphKey::Delete => {
                if range.start == range.end {
                    match key {
                        ParagraphKey::Backspace => {
                            range.start =
                                DisplayOffset(stop(range.start.0, CaretDirection::Backward)?);
                        }
                        ParagraphKey::Delete => {
                            range.end = DisplayOffset(stop(range.end.0, CaretDirection::Forward)?);
                        }
                        _ => unreachable!(),
                    }
                    // An image is one unit: a caret's deletion that reaches into one removes it whole,
                    // never leaving the rest of its spelling behind as text.
                    for atom in self.projection.atom_descriptions(range) {
                        if atom.kind == crate::AtomKind::Image
                            && atom.range.start.0 < range.end.0
                            && atom.range.end.0 > range.start.0
                        {
                            range.start = DisplayOffset(range.start.0.min(atom.range.start.0));
                            range.end = DisplayOffset(range.end.0.max(atom.range.end.0));
                        }
                    }
                    // The body start is the boundary when front matter precedes it.
                    if range.start == range.end || range.start.0 < self.projection.body_start() {
                        return Ok(None);
                    }
                }
                ""
            }
        };
        self.replace_action(expected, range, inserted, InputAction::Isolated, accept)
            .map(Some)
    }

    pub fn paragraph_key_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        key: ParagraphKey,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (range, _) = self.decode_utf16_input(expected, range, &[])?;
        self.paragraph_key(expected, range, key, accept)
    }
}
