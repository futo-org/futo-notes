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
    /// Text-first heading-start deletion joins the preceding physical line.
    BackspaceJoiningHeading,
    Delete,
    Tab,
    ShiftTab,
}

impl EditorSession {
    /// Paragraph Enter/Shift+Enter insert one line break, CRLF on a CRLF line. Directional deletion removes
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
        range = self.body_range(self.outside_crlf(range))?;
        let span = range.start.0..range.end.0;
        let shown = match key {
            ParagraphKey::Enter | ParagraphKey::ShiftEnter => crate::inline::Expected::Enter(span),
            ParagraphKey::Delete => crate::inline::Expected::Deleted(span, true),
            ParagraphKey::Backspace | ParagraphKey::BackspaceJoiningHeading => {
                crate::inline::Expected::Deleted(span, false)
            }
            // Tab keys are not checked inputs: they plan as before repairs.
            ParagraphKey::Tab | ParagraphKey::ShiftTab => {
                return self.lf_paragraph_key(expected, range, key, accept);
            }
        };
        self.checked_input(shown, accept, |session, accept| {
            // A line break takes the caret line's spelling, as pasted ones do.
            if matches!(key, ParagraphKey::Enter | ParagraphKey::ShiftEnter) {
                let (at, _) = session.projection.source_bounds(range.start.0);
                if session.line_ending_at(at) == "\r\n" {
                    return session.crlf_enter(expected, range, key, accept);
                }
            }
            session.lf_paragraph_key(expected, range, key, accept)
        })
    }

    /// `paragraph_key` with every line break the key writes spelled LF.
    pub(in crate::session) fn lf_paragraph_key(
        &mut self,
        expected: Revision,
        mut range: DisplayRange,
        mut key: ParagraphKey,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if key == ParagraphKey::BackspaceJoiningHeading {
            if let Some(change) = self.heading_join_backspace(expected, range, accept)? {
                return Ok(Some(change));
            }
            key = ParagraphKey::Backspace;
        }
        if matches!(key, ParagraphKey::Tab | ParagraphKey::ShiftTab) {
            let outdent = key == ParagraphKey::ShiftTab;
            if let Some(change) = self.fence_indent(expected, range, outdent, true, accept)? {
                return Ok(Some(change));
            }
            return self.list_tab(expected, range, outdent, accept);
        }
        if matches!(key, ParagraphKey::Enter | ParagraphKey::ShiftEnter) {
            // An image selected as one object is not replaced by Enter: the
            // key acts after it, which is how a caret gets past a last image.
            if range.start != range.end
                && self
                    .projection
                    .atom_descriptions(range)
                    .iter()
                    .any(|atom| atom.kind == crate::AtomKind::Image && atom.range == range)
            {
                range.start = range.end;
            }
            // So is a code block selected as one object: Enter acts after it.
            if let Some(fence) = self.selected_fence(range) {
                if let Some(change) = self.fence_selected_enter(expected, &fence, accept)? {
                    return Ok(Some(change));
                }
                range.start = range.end;
            }
            let shift = key == ParagraphKey::ShiftEnter;
            if let Some(change) = self.cell_enter(expected, range, shift, accept)? {
                return Ok(Some(change));
            }
            if let Some(change) = self.fence_conversion(expected, range, "\n", accept)? {
                return Ok(Some(change));
            }
            if let Some(change) = self.fence_enter(expected, range, accept)? {
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
            ParagraphKey::Tab | ParagraphKey::ShiftTab | ParagraphKey::BackspaceJoiningHeading => {
                unreachable!()
            }
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
