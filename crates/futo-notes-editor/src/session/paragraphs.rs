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
}

impl EditorSession {
    /// Paragraph Enter/Shift+Enter insert one LF. Directional deletion removes
    /// the selection or one visible extended grapheme (CRLF is one line break).
    /// Structural block/table keys belong to their subsequent command layer.
    /// Boundary deletion is a no-op with no acceptance, revision or history.
    pub fn paragraph_key(
        &mut self,
        expected: Revision,
        mut range: DisplayRange,
        key: ParagraphKey,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        let overlay = self
            .composition
            .as_ref()
            .map(|_| self.provisional_display());
        if let Some(display) = &overlay {
            super::composition::validate_overlay_range(display, range)?;
        } else {
            self.validate_range(range)?;
        }
        let stop = |position, direction| match &overlay {
            Some(display) => Self::grapheme_stop_in(display, position, direction, false),
            None => self.grapheme_stop(position, direction, false),
        };
        let inserted = match key {
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
                    if range.start == range.end {
                        return Ok(None);
                    }
                }
                ""
            }
        };
        if overlay.is_some() {
            self.finish_provisional_input(expected, range, inserted, InputAction::Isolated, accept)
        } else {
            self.replace_action(expected, range, inserted, InputAction::Isolated, accept)
                .map(Some)
        }
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
