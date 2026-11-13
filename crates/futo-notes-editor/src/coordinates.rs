//! The UTF-16 entry points native hosts call. Malformed text and positions
//! that split a surrogate pair are rejected, never clamped or widened.
use crate::{
    DisplayOffset, DisplayRange, DisplayUtf16Range, EditorError, EditorSession, Revision,
    SelectionChange, SourceEdit, SourceRange, SourceUtf16Range, ViewChange,
};

impl EditorSession {
    fn utf16_to_byte(rope: &ropey::Rope, offset: usize) -> Result<usize, EditorError> {
        let index = rope
            .try_utf16_cu_to_char(offset)
            .map_err(|_| EditorError::InvalidRange)?;
        if rope.char_to_utf16_cu(index) != offset {
            return Err(EditorError::InvalidRange);
        }
        Ok(rope.char_to_byte(index))
    }

    pub fn display_from_utf16(
        &self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<DisplayRange, EditorError> {
        self.engine().display_from_utf16(expected, range)
    }

    pub fn display_to_utf16(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<DisplayUtf16Range, EditorError> {
        self.engine().display_to_utf16(expected, range)
    }

    pub fn source_from_utf16(
        &self,
        expected: Revision,
        range: SourceUtf16Range,
    ) -> Result<SourceRange, EditorError> {
        self.engine().source_from_utf16(expected, range)
    }

    pub fn source_to_utf16(
        &self,
        expected: Revision,
        range: SourceRange,
    ) -> Result<SourceUtf16Range, EditorError> {
        self.engine().source_to_utf16(expected, range)
    }

    pub fn select_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<SelectionChange, EditorError> {
        let range = self.display_from_utf16(expected, range)?;
        self.select(expected, range)
    }

    pub fn compose_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
    ) -> Result<crate::Composition, EditorError> {
        let range = self.display_from_utf16(expected, range)?;
        let text = String::from_utf16(text).map_err(|_| EditorError::InvalidText)?;
        self.compose(expected, range, &text)
    }

    pub fn commit_composition_utf16(
        &mut self,
        expected: Revision,
        text: Option<&[u16]>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        let text = text
            .map(String::from_utf16)
            .transpose()
            .map_err(|_| EditorError::InvalidText)?;
        self.commit_composition(expected, text.as_deref(), accept)
    }

    pub fn decode_os_utf16(
        &self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
        placeholders: &[DisplayUtf16Range],
    ) -> Result<(DisplayRange, String, Vec<DisplayRange>), EditorError> {
        let (range, text) = self.decode_utf16_input(expected, range, text)?;
        let inserted = ropey::Rope::from_str(&text);
        let placeholders = placeholders
            .iter()
            .map(|range| {
                if range.start.0 > range.end.0 {
                    return Err(EditorError::InvalidRange);
                }
                Ok(DisplayRange {
                    start: DisplayOffset(Self::utf16_to_byte(&inserted, range.start.0)?),
                    end: DisplayOffset(Self::utf16_to_byte(&inserted, range.end.0)?),
                })
            })
            .collect::<Result<Vec<_>, EditorError>>()?;
        Ok((range, text, placeholders))
    }

    pub fn replace_os_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
        placeholders: &[DisplayUtf16Range],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (range, text, placeholders) =
            self.decode_os_utf16(expected, range, text, placeholders)?;
        self.replace_os(expected, range, &text, &placeholders, accept)
    }

    /// Validates native coordinates and text together at the current revision.
    /// Hosts can delegate the decoded input to their existing save workflow;
    /// applying it must still use `expected` to reject intervening edits.
    pub fn decode_utf16_input(
        &self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
    ) -> Result<(DisplayRange, String), EditorError> {
        Ok((
            self.engine().input_from_utf16(expected, range)?,
            String::from_utf16(inserted).map_err(|_| EditorError::InvalidText)?,
        ))
    }

    pub fn decode_utf16_replacements(
        &self,
        expected: Revision,
        replacements: &[crate::DisplayUtf16Replacement],
    ) -> Result<Vec<crate::DisplayReplacement>, EditorError> {
        self.check_revision(expected)?;
        replacements
            .iter()
            .map(|replacement| {
                let (range, inserted) =
                    self.decode_utf16_input(expected, replacement.range, &replacement.inserted)?;
                Ok(crate::DisplayReplacement { range, inserted })
            })
            .collect()
    }

    pub fn replace_many_utf16(
        &mut self,
        expected: Revision,
        replacements: &[crate::DisplayUtf16Replacement],
        accept: &mut dyn FnMut(&crate::SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let replacements = self.decode_utf16_replacements(expected, replacements)?;
        self.replace_many(expected, &replacements, accept)
    }

    pub fn replace_utf16_action(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
        action: crate::InputAction,
        accept: &mut dyn FnMut(&crate::SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let (range, inserted) = self.decode_utf16_input(expected, range, inserted)?;
        self.replace_action(expected, range, &inserted, action, accept)
    }

    /// Rejects malformed native text and split surrogate positions; never clamps,
    /// widens a range, normalizes line endings, or replaces invalid code units.
    pub fn replace_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let (range, inserted) = self.decode_utf16_input(expected, range, inserted)?;
        self.replace(expected, range, &inserted, accept)
    }

    pub fn inspect_table_utf16(
        &self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<Option<crate::TableDescription>, EditorError> {
        let (range, _) = self.decode_utf16_input(expected, range, &[])?;
        self.inspect_table(expected, range)
    }

    pub fn table_command_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        command: crate::TableCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (range, _) = self.decode_utf16_input(expected, range, &[])?;
        self.table_command(expected, range, command, accept)
    }

    pub fn find_matches_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<Vec<DisplayRange>, EditorError> {
        let (range, _) = self.decode_utf16_input(expected, range, &[])?;
        self.find_matches(expected, range)
    }

    pub fn block_command_utf16(
        &mut self,
        expected: Revision,
        range: crate::DisplayUtf16Range,
        command: crate::BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (range, _) = self.decode_utf16_input(expected, range, &[])?;
        self.block_command(expected, range, command, accept)
    }

    pub fn paragraph_key_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        key: crate::ParagraphKey,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (range, _) = self.decode_utf16_input(expected, range, &[])?;
        self.paragraph_key(expected, range, key, accept)
    }
}
