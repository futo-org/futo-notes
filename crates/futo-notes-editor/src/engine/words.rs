//! Words, as a double click, Option+Arrow and Option+Backspace read them: ICU4X's word
//! segmenter with its full dictionaries, so Chinese, Japanese and Southeast Asian scripts
//! split as macOS splits them (the smaller LSTM models split Thai and Lao wrongly). A word
//! never crosses a line break, so each look segments one display line.
//!
//! `host::DisplayMirror::word_stop` is a different rule on purpose: it maps a native
//! view's own word delete onto the engine (UAX #29 without dictionaries, a punctuation
//! run is a stop, never past a line edge), so it stays with what that view deleted.
use super::{store, Engine};
use crate::{CaretDirection, DisplayOffset, DisplayRange, EditorError, Revision};
use icu_segmenter::{options::WordBreakInvariantOptions, WordSegmenter};
use std::ops::Range;

/// One segment of a display line, in display offsets.
struct Segment {
    range: Range<usize>,
    is_word: bool,
}

/// `text`'s segments, offset by `start`.
fn segments(text: &str, start: usize) -> Vec<Segment> {
    let segmenter = WordSegmenter::new_dictionary(WordBreakInvariantOptions::default());
    let mut from = 0;
    segmenter
        .segment_str(text)
        .iter_with_word_type()
        .filter_map(|(to, kind)| {
            let segment_start = std::mem::replace(&mut from, to);
            (to > segment_start).then(|| Segment {
                range: start + segment_start..start + to,
                is_word: kind.is_word_like(),
            })
        })
        .collect()
}

impl Engine {
    /// The display line holding display offset `at`, its line break left out. A line
    /// break shows only at the end of a line whose ending shows; hidden lines between
    /// belong to the display line around them.
    pub(super) fn display_line(&self, at: usize) -> Range<usize> {
        let (index, before) = self.line_at_display(store::display, at);
        let mut start = before.display;
        let mut first = index;
        while first > 0 && !self.store.get(first - 1).view.ending {
            first -= 1;
            start -= self.store.get(first).size.display;
        }
        let mut end = before.display;
        for entry in self.store.iter_from(index) {
            if entry.view.ending {
                end += entry.shown_len();
                break;
            }
            end += entry.size.display;
        }
        start..end
    }

    /// A table's delimiter row has none: no caret stands on it.
    fn line_segments(&self, line: Range<usize>) -> Vec<Segment> {
        if self.on_delimiter_row(line.start) {
            return Vec::new();
        }
        segments(&self.display_slice(line.clone()), line.start)
    }

    /// Display offset `offset`, checked, and moved out of a CRLF as a caret is.
    fn word_offset(&self, expected: Revision, offset: DisplayOffset) -> Result<usize, EditorError> {
        self.check_revision(expected)?;
        self.check_display(offset.0)?;
        let caret = DisplayRange {
            start: offset,
            end: offset,
        };
        Ok(self.outside_crlf(caret).start.0)
    }

    /// The word a double click at `offset` selects: the segment there (a run of spaces or
    /// punctuation is one), or, where only the text before `offset` is a word (past a
    /// word's or the line's end), that word. Empty on an empty line and on a table's
    /// delimiter row.
    pub fn word_at(
        &self,
        expected: Revision,
        offset: DisplayOffset,
    ) -> Result<DisplayRange, EditorError> {
        let at = self.word_offset(expected, offset)?;
        let segments = self.line_segments(self.display_line(at));
        let after = segments.iter().find(|segment| segment.range.contains(&at));
        let before = segments.iter().find(|segment| segment.range.end == at);
        let chosen = match (before, after) {
            (Some(before), Some(after)) if before.is_word && !after.is_word => Some(before),
            (_, Some(after)) => Some(after),
            (before, None) => before,
        };
        let range = chosen.map_or(at..at, |segment| segment.range.clone());
        Ok(DisplayRange {
            start: DisplayOffset(range.start),
            end: DisplayOffset(range.end),
        })
    }

    /// Where Option+Arrow from `offset` stops, and Option+Backspace deletes to: the end of
    /// the next word forward, the start of the previous one backward, across line breaks
    /// and blank lines as AppKit's word motion goes; past the last word, the note's end
    /// (start), or the header's end where a table's delimiter row ends the note.
    pub fn word_stop(
        &self,
        expected: Revision,
        offset: DisplayOffset,
        direction: CaretDirection,
    ) -> Result<DisplayOffset, EditorError> {
        let mut at = self.word_offset(expected, offset)?;
        loop {
            let line = self.display_line(at);
            let segments = self.line_segments(line.clone());
            let stop = match direction {
                CaretDirection::Forward => segments
                    .iter()
                    .find(|segment| segment.is_word && segment.range.end > at)
                    .map(|segment| segment.range.end),
                CaretDirection::Backward => segments
                    .iter()
                    .rev()
                    .find(|segment| segment.is_word && segment.range.start < at)
                    .map(|segment| segment.range.start),
            };
            if let Some(stop) = stop {
                return Ok(DisplayOffset(stop));
            }
            at = match direction {
                CaretDirection::Forward if line.end < self.display_len() => {
                    let crlf = self.display_slice(line.end..line.end + 1) == "\r";
                    line.end + if crlf { 2 } else { 1 }
                }
                CaretDirection::Backward if line.start > 0 => line.start - 1,
                CaretDirection::Forward => {
                    let end = self.past_delimiter_row(self.display_len(), direction);
                    return Ok(DisplayOffset(end));
                }
                CaretDirection::Backward => return Ok(DisplayOffset(0)),
            };
        }
    }
}
