//! UTF-16 conversions for native views: never split a surrogate pair and
//! never clamp.
use super::{read, store, Engine};
use crate::{
    DisplayOffset, DisplayRange, DisplayUtf16Offset, DisplayUtf16Range, EditorError, Revision,
    SourceOffset, SourceRange, SourceUtf16Offset, SourceUtf16Range,
};

impl Engine {
    // ---- UTF-16 ----

    /// The UTF-16 offset of display offset `at`.
    pub(super) fn display16(&self, at: usize) -> Result<usize, EditorError> {
        let (index, before) = self.check_display(at)?;
        let shown = self.store.get(index).display();
        Ok(before.display16 + shown[..at - before.display].encode_utf16().count())
    }

    /// The display offset of UTF-16 offset `at`; one that splits a surrogate
    /// pair, or lies past the end, is refused, never clamped.
    pub(super) fn display_from16(&self, at: usize) -> Result<usize, EditorError> {
        if at > self.store.total().display16 {
            return Err(EditorError::InvalidRange);
        }
        let (index, before) = self.line_at_display(store::display16, at);
        let shown = self.store.get(index).display();
        utf16_to_byte(&shown, at - before.display16).map(|local| before.display + local)
    }

    pub(super) fn source16(&self, at: usize) -> Result<usize, EditorError> {
        self.check_source(at)?;
        let (index, before) = read::line_at(&self.store, at);
        let text = &self.store.get(index).text;
        Ok(before.source16 + text[..at - before.source].encode_utf16().count())
    }

    pub(super) fn source_from16(&self, at: usize) -> Result<usize, EditorError> {
        if at > self.store.total().source16 {
            return Err(EditorError::InvalidRange);
        }
        let (index, before) = self
            .store
            .line_past(store::source16, at)
            .unwrap_or_else(|| {
                let last = self.store.len() - 1;
                (last, self.store.before(last))
            });
        let text = &self.store.get(index).text;
        utf16_to_byte(text, at - before.source16).map(|local| before.source + local)
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
            start: DisplayUtf16Offset(self.display16(range.start.0)?),
            end: DisplayUtf16Offset(self.display16(range.end.0)?),
        })
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
            start: DisplayOffset(self.display_from16(range.start.0)?),
            end: DisplayOffset(self.display_from16(range.end.0)?),
        })
    }

    pub fn source_to_utf16(
        &self,
        expected: Revision,
        range: SourceRange,
    ) -> Result<SourceUtf16Range, EditorError> {
        self.check_revision(expected)?;
        if range.start.0 > range.end.0 {
            return Err(EditorError::InvalidRange);
        }
        Ok(SourceUtf16Range {
            start: SourceUtf16Offset(self.source16(range.start.0)?),
            end: SourceUtf16Offset(self.source16(range.end.0)?),
        })
    }

    pub fn source_from_utf16(
        &self,
        expected: Revision,
        range: SourceUtf16Range,
    ) -> Result<SourceRange, EditorError> {
        self.check_revision(expected)?;
        if range.start.0 > range.end.0 {
            return Err(EditorError::InvalidRange);
        }
        Ok(SourceRange {
            start: SourceOffset(self.source_from16(range.start.0)?),
            end: SourceOffset(self.source_from16(range.end.0)?),
        })
    }
}

/// The byte offset in `text` of UTF-16 offset `at`, refusing one inside a
/// surrogate pair.
pub(super) fn utf16_to_byte(text: &str, at: usize) -> Result<usize, EditorError> {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units == at {
            return Ok(byte);
        }
        units += ch.len_utf16();
        if units > at {
            return Err(EditorError::InvalidRange);
        }
    }
    if units == at {
        Ok(text.len())
    } else {
        Err(EditorError::InvalidRange)
    }
}
