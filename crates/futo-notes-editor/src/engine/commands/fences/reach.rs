//! A code block is one object: a display range either stays inside one
//! block's code or takes every block it reaches into whole, fences and all.
//! Replacing, deleting, cutting and copying a range all ask `block_reach`.
use super::super::super::code_block::{is_code_line, CodeBlock};
use super::super::super::{store, Engine};
use crate::lines::FenceRole;
use crate::DisplayRange;
use std::ops::Range;

impl Engine {
    /// The code block whose code shows at display offset `at`, from its
    /// first code line's start through its last code line's end.
    pub(in crate::engine) fn code_block_at(&self, at: usize) -> Option<CodeBlock> {
        let (index, _) = self.line_at_display(store::display, at);
        is_code_line(self.line(index)).then(|| CodeBlock::holding(&self.store, index))
    }

    /// A block's whole source: from its opening line's start through its
    /// closing line, or through its last code line when nothing closes it.
    pub(in crate::engine) fn block_source(&self, block: &CodeBlock) -> Range<usize> {
        let start = self.line_start(block.opener);
        let last = block.closer.unwrap_or(block.last);
        start..self.line_start(last) + self.line(last).body_len()
    }

    /// The source that replacing display `range` takes, when code blocks
    /// make it differ from the range's own: the selected block whole; a
    /// block the range reaches into or out of, whole; a range that only
    /// meets a block's outer edge stops there. A range from inside a block's
    /// code to the start of the line after it holds the break that stands
    /// for the hidden closing fence, so it takes the block whole; past a
    /// block that ends the note, where no line follows, it stays in the
    /// code. One that starts at the end of a block's code starts after its
    /// line break.
    pub(crate) fn block_reach(&self, range: DisplayRange) -> Option<Range<usize>> {
        if self.block_selected && range == self.selection {
            return self
                .code_block_at(range.start.0)
                .map(|block| self.block_source(&block));
        }
        let (mut start, end) = (range.start.0, range.end.0);
        if start == end {
            return None;
        }
        let mut inside = self.code_block_at(start);
        let reached = self.code_block_at(end);
        if inside.is_none() && reached.is_none() {
            return None;
        }
        let mut from = self.source_bounds(start).1;
        let mut to = self.source_bounds(end).0;
        let mut changed = false;
        // A block that shows no code (one empty line) has no inside: a range
        // from it takes it whole.
        let shows_code =
            |block: &CodeBlock| block.description.range.start != block.description.range.end;
        if let Some(block) = inside.as_ref().filter(|block| shows_code(block)) {
            let below = self.store.before(block.last + 1).display;
            if start == block.description.range.end.0 && end >= below {
                start = below;
                from = self.source_bounds(start).1;
                inside = self.code_block_at(start);
                changed = true;
            }
        }
        if let Some(block) = &inside {
            let below = self.store.before(block.last + 1).display;
            let ends_note = block
                .closer
                .is_none_or(|closer| closer + 1 >= self.line_count());
            if shows_code(block) && block.description.range.end.0 < end && end <= below && ends_note
            {
                to = self.line_start(block.last) + self.line(block.last).body_len();
                changed = true;
            } else if block.description.range.end.0 < end {
                from = self.block_source(block).start;
                changed = true;
            }
        }
        if let Some(block) = &reached {
            let edge = block.description.range.start.0;
            let same = inside
                .as_ref()
                .is_some_and(|inside| inside.opener == block.opener);
            if start < edge && !same {
                // Ending where a block's code starts touches none of it, except
                // at the note's end, past a block that shows no code.
                to = if end == edge && end < self.display_len() {
                    self.line_start(block.opener)
                } else {
                    self.block_source(block).end
                };
                changed = true;
            }
        }
        changed.then(|| from..to.max(from))
    }

    /// Where replacing source `from..to` stops when `to` is where an opening
    /// fence's line starts: there when whole lines go and nothing is written
    /// (`writes`), else before the line break above it, so no text joins
    /// the fence.
    pub(crate) fn kept_break(&self, from: usize, to: usize, writes: bool) -> usize {
        let index = self.line_of(to);
        if to == from
            || index == 0
            || to != self.line_start(index)
            || self.role(index) != Some(FenceRole::Open)
        {
            return to;
        }
        if !writes && from == self.line_start(self.line_of(from)) {
            return to;
        }
        (self.line_start(index - 1) + self.line(index - 1).body_len()).max(from)
    }

    /// The bytes a replacement of display `range` that takes a code block
    /// whole keeps unchanged at its start and end (`prefix`, `suffix`, shared
    /// with the text): none inside a block it takes, and never so many that
    /// the changed stretch no longer leaves the block its start is in.
    pub(crate) fn stretch_taking_blocks(
        &self,
        range: DisplayRange,
        prefix: usize,
        suffix: usize,
    ) -> (usize, usize) {
        let (start, end) = (range.start.0, range.end.0);
        let inside = self.code_block_at(start);
        let prefix = if inside.is_some() { 0 } else { prefix };
        let falls_back =
            inside.is_some_and(|block| end - suffix <= self.store.before(block.last + 1).display);
        let suffix = if falls_back || self.code_block_at(end).is_some() {
            0
        } else {
            suffix
        };
        (prefix, suffix)
    }
}
