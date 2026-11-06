use ropey::Rope;

/// Why a coordinate was refused; the mirror is unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MirrorError {
    OutOfRange,
    /// A UTF-8 offset inside a scalar, or a UTF-16 offset between a surrogate pair.
    SplitCharacter,
    /// Start after end.
    Reversed,
}

/// One engine change in the host's UTF-16 coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MirrorEdit {
    /// The replaced range of the previous display, in UTF-16 units.
    pub start: usize,
    pub end: usize,
    /// UTF-16 units inserted at `start`.
    pub inserted_utf16: usize,
    /// The resulting selection, in UTF-16 units of the new display.
    pub selection_start: usize,
    pub selection_end: usize,
}

/// The host's copy of the engine's display text, kept in step by applying each
/// accepted change. The engine speaks display UTF-8 bytes; platform text views
/// speak UTF-16 units, so every change and selection is converted here in
/// logarithmic time (a rope, not a scan), once, instead of in each renderer.
#[derive(Debug, Clone, Default)]
pub struct DisplayMirror {
    rope: Rope,
}

impl DisplayMirror {
    pub fn new(display: &str) -> Self {
        Self {
            rope: Rope::from_str(display),
        }
    }

    pub fn reset(&mut self, display: &str) {
        self.rope = Rope::from_str(display);
    }

    pub fn byte_len(&self) -> usize {
        self.rope.len_bytes()
    }

    pub fn utf16_len(&self) -> usize {
        self.rope.len_utf16_cu()
    }

    pub fn text(&self) -> String {
        self.rope.to_string()
    }

    pub fn byte_to_utf16(&self, byte: usize) -> Result<usize, MirrorError> {
        let char_index = self
            .rope
            .try_byte_to_char(byte)
            .map_err(|_| MirrorError::OutOfRange)?;
        if self.rope.char_to_byte(char_index) != byte {
            return Err(MirrorError::SplitCharacter);
        }
        Ok(self.rope.char_to_utf16_cu(char_index))
    }

    pub fn utf16_to_byte(&self, unit: usize) -> Result<usize, MirrorError> {
        let char_index = self
            .rope
            .try_utf16_cu_to_char(unit)
            .map_err(|_| MirrorError::OutOfRange)?;
        if self.rope.char_to_utf16_cu(char_index) != unit {
            return Err(MirrorError::SplitCharacter);
        }
        Ok(self.rope.char_to_byte(char_index))
    }

    /// The text of a UTF-16 range, for a host that must repaint a region.
    pub fn slice_utf16(&self, start: usize, end: usize) -> Result<String, MirrorError> {
        if start > end {
            return Err(MirrorError::Reversed);
        }
        let from = self.utf16_to_byte(start)?;
        let to = self.utf16_to_byte(end)?;
        Ok(self.rope.byte_slice(from..to).to_string())
    }

    /// A selection of the current display, as UTF-16 units.
    pub fn selection_utf16(&self, start: usize, end: usize) -> Result<(usize, usize), MirrorError> {
        if start > end {
            return Err(MirrorError::Reversed);
        }
        Ok((self.byte_to_utf16(start)?, self.byte_to_utf16(end)?))
    }

    /// Apply one engine change: `[start, end)` of the previous display (bytes)
    /// became `inserted`, and the resulting selection is `selection` (bytes of
    /// the new display). Nothing changes when any coordinate is refused.
    pub fn apply_change(
        &mut self,
        start: usize,
        end: usize,
        inserted: &str,
        selection: (usize, usize),
    ) -> Result<MirrorEdit, MirrorError> {
        if start > end {
            return Err(MirrorError::Reversed);
        }
        let from = self.byte_to_utf16(start)?;
        let to = self.byte_to_utf16(end)?;
        let (first, last) = (self.rope.byte_to_char(start), self.rope.byte_to_char(end));
        let before = self.rope.clone();
        self.rope.remove(first..last);
        self.rope.insert(first, inserted);
        match self.selection_utf16(selection.0, selection.1) {
            Ok((selection_start, selection_end)) => Ok(MirrorEdit {
                start: from,
                end: to,
                inserted_utf16: inserted.encode_utf16().count(),
                selection_start,
                selection_end,
            }),
            Err(error) => {
                self.rope = before;
                Err(error)
            }
        }
    }
}
