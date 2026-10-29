use crate::{
    DisplayOffset, DisplayRange, DisplayUtf16Offset, DisplayUtf16Range, EditorError, EditorSession,
    Revision, SelectionChange, SourceEdit, SourceOffset, SourceRange, SourceUtf16Offset,
    SourceUtf16Range, ViewChange,
};

impl EditorSession {
    fn utf16_to_byte(&self, offset: usize) -> Result<usize, EditorError> {
        let index = self
            .source
            .try_utf16_cu_to_char(offset)
            .map_err(|_| EditorError::InvalidRange)?;
        if self.source.char_to_utf16_cu(index) != offset {
            return Err(EditorError::InvalidRange);
        }
        Ok(self.source.char_to_byte(index))
    }

    pub fn display_from_utf16(
        &self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<DisplayRange, EditorError> {
        self.check_revision(expected)?;
        if range.start.0 > range.end.0 {
            return Err(EditorError::InvalidRange);
        }
        Ok(DisplayRange {
            start: DisplayOffset(self.utf16_to_byte(range.start.0)?),
            end: DisplayOffset(self.utf16_to_byte(range.end.0)?),
        })
    }

    pub fn display_to_utf16(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<DisplayUtf16Range, EditorError> {
        self.check_revision(expected)?;
        if range.start.0 > range.end.0 {
            return Err(EditorError::InvalidRange);
        }
        Ok(DisplayUtf16Range {
            start: DisplayUtf16Offset(self.source.char_to_utf16_cu(self.char_index(range.start)?)),
            end: DisplayUtf16Offset(self.source.char_to_utf16_cu(self.char_index(range.end)?)),
        })
    }

    // Source and display share text only in this plain-text slice. Keeping these
    // types distinct prevents native callers from assuming that correspondence.
    pub fn source_from_utf16(
        &self,
        expected: Revision,
        range: SourceUtf16Range,
    ) -> Result<SourceRange, EditorError> {
        let display = self.display_from_utf16(
            expected,
            DisplayUtf16Range {
                start: DisplayUtf16Offset(range.start.0),
                end: DisplayUtf16Offset(range.end.0),
            },
        )?;
        Ok(SourceRange {
            start: SourceOffset(display.start.0),
            end: SourceOffset(display.end.0),
        })
    }

    pub fn source_to_utf16(
        &self,
        expected: Revision,
        range: SourceRange,
    ) -> Result<SourceUtf16Range, EditorError> {
        let display = self.display_to_utf16(
            expected,
            DisplayRange {
                start: DisplayOffset(range.start.0),
                end: DisplayOffset(range.end.0),
            },
        )?;
        Ok(SourceUtf16Range {
            start: SourceUtf16Offset(display.start.0),
            end: SourceUtf16Offset(display.end.0),
        })
    }

    pub fn select_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<SelectionChange, EditorError> {
        let range = self.display_from_utf16(expected, range)?;
        self.select(expected, range)
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
        let range = self.display_from_utf16(expected, range)?;
        let inserted = String::from_utf16(inserted).map_err(|_| EditorError::InvalidText)?;
        Ok((range, inserted))
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
}
