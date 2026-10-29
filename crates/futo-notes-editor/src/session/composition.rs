//! Marked text is a provisional overlay over a pinned committed-display range.
use super::*;
use serde::{Deserialize, Serialize};

/// Views draw this overlay without interpreting markdown. Its range always
/// addresses committed display text, never the provisional string's offsets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Composition {
    pub revision: Revision,
    pub range: DisplayRange,
    pub text: String,
}

impl EditorSession {
    pub fn composition(&self) -> Option<&Composition> {
        self.composition.as_ref()
    }

    /// Repeated updates retain the opening range. Hosts supply the complete
    /// marked string, including when a native IME replaces its last character.
    pub fn compose(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Composition, EditorError> {
        self.check_revision(expected)?;
        self.validate_range(range)?;
        let range = self
            .composition
            .as_ref()
            .map_or(range, |marked| marked.range);
        let marked = Composition {
            revision: expected,
            range,
            text: text.into(),
        };
        self.composition = Some(marked.clone());
        Ok(marked)
    }

    /// A changed native commit replaces the staged string. Failed recovery
    /// acceptance leaves the marked text available for retry or cancellation.
    pub fn commit_composition(
        &mut self,
        expected: Revision,
        text: Option<&str>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        let Some(marked) = self.composition.clone() else {
            return Ok(None);
        };
        self.composition = None;
        match self.replace_os(
            expected,
            marked.range,
            text.unwrap_or(&marked.text),
            &[],
            accept,
        ) {
            Ok(change) => Ok(change),
            Err(error) => {
                self.composition = Some(marked);
                Err(error)
            }
        }
    }

    pub(crate) fn provisional_display(&self) -> Rope {
        let mut text = self.projection.display.clone();
        if let Some(marked) = &self.composition {
            let start = text.byte_to_char(marked.range.start.0);
            let end = text.byte_to_char(marked.range.end.0);
            text.remove(start..end);
            text.insert(start, &marked.text);
        }
        text
    }

    pub(super) fn input_during_composition(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        match self.finish_provisional_input(expected, range, inserted, accept)? {
            Some(change) => Ok(change),
            None => self.replace_action(
                expected,
                DisplayRange {
                    start: self.selection.end,
                    end: self.selection.end,
                },
                "",
                crate::InputAction::Isolated,
                accept,
            ),
        }
    }

    pub(super) fn finish_provisional_input(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let display = self.provisional_display();
        validate_overlay_range(&display, range)?;
        let marked = self.composition.as_ref().unwrap();
        let start = marked.range.start.0.min(range.start.0);
        let end = (marked.range.start.0 + marked.text.len()).max(range.end.0);
        let committed_end = end - marked.text.len() + marked.range.end.0 - marked.range.start.0;
        let mut text = display.byte_slice(start..end).to_string();
        text.replace_range(range.start.0 - start..range.end.0 - start, inserted);
        let marked = self.composition.take();
        let full = DisplayRange {
            start: DisplayOffset(start),
            end: DisplayOffset(committed_end),
        };
        let result = self.replace_os(expected, full, &text, &[], accept);
        match result {
            Ok(mut change) => {
                self.finish_os_selection(range.start.0 + inserted.len(), change.as_mut());
                Ok(change)
            }
            Err(error) => {
                self.composition = marked;
                Err(error)
            }
        }
    }

    pub(super) fn compound_during_composition(
        &mut self,
        expected: Revision,
        replacements: &[crate::DisplayReplacement],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        if replacements.is_empty() {
            return Err(EditorError::InvalidRange);
        }
        let display = self.provisional_display();
        let first = replacements.first().unwrap().range.start.0;
        let end = replacements.last().unwrap().range.end.0;
        for (index, replacement) in replacements.iter().enumerate() {
            validate_overlay_range(&display, replacement.range)?;
            if index > 0
                && (replacements[index - 1].range.end.0 > replacement.range.start.0
                    || replacements[index - 1].range.start == replacement.range.start)
            {
                return Err(EditorError::InvalidRange);
            }
        }
        let mut text = display.byte_slice(first..end).to_string();
        for replacement in replacements.iter().rev() {
            text.replace_range(
                replacement.range.start.0 - first..replacement.range.end.0 - first,
                &replacement.inserted,
            );
        }
        let last = replacements.last().unwrap();
        let caret = first + text.len();
        let mut change = self.input_during_composition(
            expected,
            DisplayRange {
                start: DisplayOffset(first),
                end: DisplayOffset(last.range.end.0),
            },
            &text,
            accept,
        )?;
        self.finish_os_selection(caret, Some(&mut change));
        Ok(change)
    }

    pub fn cancel_composition(&mut self, expected: Revision) -> Result<(), EditorError> {
        self.check_revision(expected)?;
        self.composition = None;
        Ok(())
    }
}

fn validate_overlay_range(display: &Rope, range: DisplayRange) -> Result<(), EditorError> {
    if range.start.0 > range.end.0 {
        return Err(EditorError::InvalidRange);
    }
    for offset in [range.start.0, range.end.0] {
        let index = display
            .try_byte_to_char(offset)
            .map_err(|_| EditorError::InvalidRange)?;
        if display.char_to_byte(index) != offset {
            return Err(EditorError::InvalidRange);
        }
    }
    Ok(())
}
