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

/// How far past its target a slice may run to reach a blank line, in slices.
const SLICE_REACH: usize = 10;

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
    /// How many UTF-16 units earlier the same edit could equally have been spelled, when it is a
    /// pure insertion or deletion inside a run the engine's smallest-change report slid to the
    /// right ("a" typed at the start of "aa" is reported at 2, and could be at 0, 1 or 2): the
    /// text is the same at `start - slack ..= start`. 0 for any other edit.
    pub slack: usize,
}

/// Longest run, in scalars, measured for [`MirrorEdit::slack`]; a longer run is cut here.
const SLACK_REACH: usize = 1024;

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

    /// Where a render slice starting at `from` ends (UTF-16 units): just after the line before the
    /// first blank line at or past `chars` units on, else after the next line end, else the end of
    /// the text. A blank line ends every block that spans lines (a table, a paragraph, an inline
    /// mark), so a slice never cuts one in two: the engine reports a table only from the slice it
    /// starts in. A text with no blank line within ten slices keeps whole lines. Always on a
    /// scalar boundary, never behind `from`'s target by more than a line.
    pub fn slice_end(&self, from: usize, chars: usize) -> Result<usize, MirrorError> {
        let len = self.utf16_len();
        if from > len {
            return Err(MirrorError::OutOfRange);
        }
        let target = from.saturating_add(chars);
        if target >= len {
            return Ok(len);
        }
        let reach = target.saturating_add(chars.saturating_mul(SLICE_REACH));
        // A blank line: "\n\n" whose first newline is at or after `target - 1`.
        let first = self.rope.utf16_cu_to_char(target.saturating_sub(1));
        let mut unit = self.rope.char_to_utf16_cu(first);
        let mut previous_newline = false;
        for c in self.rope.chars_at(first) {
            if unit > reach {
                break;
            }
            if c == '\n' && previous_newline {
                // `unit` is the second newline; the slice ends after the first.
                return Ok(unit);
            }
            previous_newline = c == '\n';
            unit += c.len_utf16();
        }
        // No blank line within reach: whole lines, from `target` on.
        let from_char = self.rope.utf16_cu_to_char(target);
        let mut unit = self.rope.char_to_utf16_cu(from_char);
        for c in self.rope.chars_at(from_char) {
            unit += c.len_utf16();
            if c == '\n' {
                return Ok(unit);
            }
        }
        Ok(len)
    }

    /// Whether the display starts with exactly `prefix` (bytes, not Unicode equivalence); the
    /// prefix's length in UTF-16 units when it does. A host that showed a long note's first
    /// screens before its session existed keeps them only when this holds.
    pub fn begins_with(&self, prefix: &str) -> Option<usize> {
        let head = self.rope.get_byte_slice(..prefix.len())?;
        (head == prefix).then(|| prefix.encode_utf16().count())
    }

    /// [`MirrorEdit::slack`] of the edit that turned `before` into the current rope: `[first,
    /// last)` scalars replaced by `inserted` scalars. Sliding the edit left by `m` scalars gives
    /// the same text exactly when, for every step up to `m`, the scalar the edit's new end passes
    /// equals the one its old end passes.
    fn slack(&self, before: &Rope, first: usize, last: usize, inserted: usize) -> usize {
        if first != last && inserted != 0 {
            return 0;
        }
        let mut run = 0;
        while run < first.min(SLACK_REACH)
            && self.rope.char(first + inserted - run - 1) == before.char(last - run - 1)
        {
            run += 1;
        }
        before.char_to_utf16_cu(first) - before.char_to_utf16_cu(first - run)
    }

    /// Where a key replays on the engine, at the engine's caret: `view` is the range UIKit-style
    /// input asked to replace on the view's frozen text, `view_selection` the selection that view
    /// had, `engine_selection` the engine's now (all UTF-16). A key's range is relative to the
    /// view's selection (a Backspace at a caret asks for the unit before it, typing over a
    /// selection asks for the selection), so it keeps that offset from the engine's selection:
    /// the engine's caret has moved on with the keys before it, the frozen view's has not. The
    /// result is clamped to the text and shrunk to scalar boundaries (a Backspace over an emoji
    /// asks for two units, but what is before the engine's caret now may be one).
    pub fn at_caret(
        &self,
        view: (usize, usize),
        view_selection: (usize, usize),
        engine_selection: (usize, usize),
    ) -> (usize, usize) {
        let len = self.utf16_len();
        let shifted = |at: usize, from: usize, to: usize| {
            (to as i64 + at as i64 - from as i64).clamp(0, len as i64) as usize
        };
        let mut start = shifted(view.0, view_selection.0, engine_selection.0);
        let mut end = shifted(view.1, view_selection.1, engine_selection.1);
        while start < end && self.utf16_to_byte(start).is_err() {
            start += 1;
        }
        while end > start && self.utf16_to_byte(end).is_err() {
            end -= 1;
        }
        // An empty range may sit inside a pair (a stale caret): step it back onto the boundary.
        while end == start && self.utf16_to_byte(start).is_err() {
            (start, end) = (start - 1, end - 1);
        }
        (start, end.max(start))
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
                slack: self.slack(&before, first, last, inserted.chars().count()),
            }),
            Err(error) => {
                self.rope = before;
                Err(error)
            }
        }
    }
}
