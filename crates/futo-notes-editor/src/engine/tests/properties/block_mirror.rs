//! A host that keeps each shown line's block and each code block only from
//! the projections of the changes it applies, never reading the note again.
//! After every change it holds what a fresh projection of the whole note
//! reports, except a code line's number and mark: a line added or removed
//! above it in its block, or a split or join, shifts those, and hosts redraw
//! them from the block's entry (fenced-code.md).
use super::View;
use crate::engine::Engine;
use crate::{BlockDescription, CodeBlockDescription, DisplayRange, ProjectionSlice, ViewChange};
use std::ops::Range;

pub(in crate::engine::tests) struct BlockMirror {
    lines: Vec<BlockDescription>,
    code_blocks: Vec<CodeBlockDescription>,
    /// Changes applied and compared.
    pub checked: usize,
}

fn whole_projection(engine: &Engine) -> ProjectionSlice {
    let end = engine.display_len();
    engine.projection(engine.revision(), display_range(0, end))
}

fn display_range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: crate::DisplayOffset(start),
        end: crate::DisplayOffset(end),
    }
}

fn span(range: &DisplayRange) -> Range<usize> {
    range.start.0..range.end.0
}

/// `blocks` without what a host takes from elsewhere: a code line's number
/// and mark.
fn without_numbers(blocks: &[BlockDescription]) -> Vec<BlockDescription> {
    blocks
        .iter()
        .cloned()
        .map(|mut block| {
            if let Some(code) = block.code.as_mut() {
                code.line_number = 0;
                code.mark = None;
            }
            block
        })
        .collect()
}

/// Whether closed ranges `a` and `b` share an offset.
fn meets(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.start <= b.end && b.start <= a.end
}

/// Keep what lies outside `replaced`, moved by the change: what ends where
/// it starts stays, what starts where it ends moves with the text after it.
fn carried(range: &mut DisplayRange, replaced: &Range<usize>, inserted: usize) -> bool {
    let old = span(range);
    if old.end < replaced.start || old.end == replaced.start && old.start < replaced.start {
        return true;
    }
    if old.start < replaced.end {
        return false;
    }
    *range = display_range(
        old.start - replaced.len() + inserted,
        old.end - replaced.len() + inserted,
    );
    true
}

impl BlockMirror {
    pub fn open(engine: &Engine) -> Self {
        let whole = whole_projection(engine);
        Self {
            lines: without_numbers(&whole.blocks),
            code_blocks: whole.code_blocks,
            checked: 0,
        }
    }

    /// Apply the change `view` took since the last check, as a host does, and
    /// compare with a fresh projection. Each step makes at most one change: an
    /// earlier change's projection would need the note it left.
    pub fn check(&mut self, engine: &Engine, view: &mut View, context: &str) {
        let edits = std::mem::take(&mut view.edits);
        let view_changes = std::mem::take(&mut view.view_changes);
        let change = match (edits.as_slice(), view_changes.as_slice()) {
            ([], []) => return,
            ([edit], []) => engine.view(edit.clone()),
            ([], [change]) => change.clone(),
            (edits, view_changes) => panic!(
                "a step made {} changes; only the last one's note is known: {context}",
                edits.len() + view_changes.len()
            ),
        };
        self.apply(&change);
        self.checked += 1;
        let fresh = Self::open(engine);
        let window = &change.projection.range;
        let differs = |have: &[BlockDescription], want: &[BlockDescription]| {
            let at = have.iter().zip(want).position(|(have, want)| have != want);
            let at = at.unwrap_or(have.len().min(want.len()));
            format!("held {:?}\nfresh {:?}", have.get(at), want.get(at))
        };
        assert!(
            self.lines == fresh.lines,
            "line blocks after {window:?}: {}\n{context}",
            differs(&self.lines, &fresh.lines)
        );
        assert_eq!(
            self.code_blocks, fresh.code_blocks,
            "code blocks after {window:?}: {context}"
        );
    }

    fn apply(&mut self, change: &ViewChange) {
        let replaced = span(&change.range);
        let inserted = change.inserted.len();
        let slice = &change.projection;
        self.lines
            .retain_mut(|line| carried(&mut line.range, &replaced, inserted));
        self.code_blocks
            .retain_mut(|block| carried(&mut block.range, &replaced, inserted));
        // The projection describes whole lines from the one holding its
        // start; a line starting at its end only when the slice says so.
        let window = span(&slice.range);
        let from = slice
            .blocks
            .first()
            .map_or(window.start, |block| block.range.start.0.min(window.start));
        let described_at_end = slice
            .blocks
            .iter()
            .any(|block| block.range.start.0 == window.end);
        self.lines.retain(|line| {
            let at = line.range.start.0;
            let empty = line.range.end.0 == at;
            !(from <= at && at < window.end || at == window.end && (empty || described_at_end))
        });
        // A block starting in the window has its first line described.
        self.code_blocks.retain(|block| {
            let range = span(&block.range);
            let described = |line: &BlockDescription| meets(&range, &span(&line.range));
            !((from..window.end).contains(&range.start) || slice.blocks.iter().any(described))
        });
        self.lines.extend(without_numbers(&slice.blocks));
        self.lines
            .sort_by_key(|line| (line.range.start.0, line.range.end.0));
        self.code_blocks.extend(slice.code_blocks.iter().cloned());
        self.code_blocks
            .sort_by_key(|block| (block.range.start.0, block.range.end.0));
    }
}
