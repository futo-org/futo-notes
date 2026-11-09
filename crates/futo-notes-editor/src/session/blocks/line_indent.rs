//! Indent and Outdent are line-start whitespace edits, whatever the lines hold
//! (list items, quotes, paragraphs, code, tables): Indent writes one tab at the
//! start of every touched line, Outdent removes one level of leading
//! whitespace. No Markdown structure is respelled, repaired or refused.
use super::*;

/// Leading spaces one Outdent removes from a line that has no leading tab:
/// the width of the tab Indent writes.
const INDENT_SPACES: usize = 4;

impl EditorSession {
    /// Indent or Outdent of the lines `range` touches, as one exact Undo action.
    pub(in crate::session) fn indent_lines(
        &mut self,
        expected: Revision,
        mut range: DisplayRange,
        outdent: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition().is_some() {
            return self.command_during_composition(
                expected,
                range,
                accept,
                |staged, local, accept| {
                    staged.indent_lines(staged.revision(), local, outdent, accept)
                },
            );
        }
        self.validate_range(range)?;
        range = self.body_range(range)?;
        let starts = self.touched_line_starts(range);
        // (line start, bytes removed there); an Indent removes none.
        let edits: Vec<(usize, usize)> = starts
            .iter()
            .copied()
            .filter_map(|at| {
                let removed = if outdent { self.outdent_width(at) } else { 0 };
                (!outdent || removed > 0).then_some((at, removed))
            })
            .collect();
        let (Some(&(first, _)), Some(&(last, last_removed))) = (edits.first(), edits.last()) else {
            return Ok(None);
        };
        let footprint = first..last + last_removed;
        let mut output = String::new();
        let mut copied = first;
        for &(at, removed) in &edits {
            output.push_str(&self.source.byte_slice(copied..at).to_string());
            if !outdent {
                output.push('\t');
            }
            copied = at + removed;
        }
        let map = |position: usize| {
            let mut result = position;
            for &(at, removed) in &edits {
                if outdent {
                    if position >= at + removed {
                        result -= removed;
                    } else if position > at {
                        result -= position - at;
                    }
                } else if position >= at {
                    result += 1;
                }
            }
            result
        };
        // Each end rests inside a touched line, on the side of any hidden
        // syntax (a fence line, a list marker) that line's text is on.
        let (low, high) = self.projection.source_bounds(range.start.0);
        let (end_low, _) = self.projection.source_bounds(range.end.0);
        let line_end = |at: usize| {
            let len = self.source.len_bytes();
            (at..len)
                .find(|&index| self.source.byte(index) == b'\n')
                .unwrap_or(len)
        };
        let inside = line_end(starts[starts.len() - 1]);
        let start = if high <= inside { high } else { low };
        let selection = if range.start == range.end {
            BlockSelection::Source(map(start))
        } else {
            BlockSelection::SourceRange(map(start)..map(end_low.max(start)))
        };
        self.commit_block_edit(expected, footprint, &output, selection, None, accept)
            .map(Some)
    }

    /// Whether Outdent has anything to remove on a line `range` touches.
    pub(in crate::session) fn has_leading_indent(&self, range: DisplayRange) -> bool {
        self.touched_line_starts(range)
            .into_iter()
            .any(|at| self.outdent_width(at) > 0)
    }

    /// The bytes one Outdent removes from the line starting at `at`: a leading
    /// tab, else up to [`INDENT_SPACES`] leading spaces.
    fn outdent_width(&self, at: usize) -> usize {
        let len = self.source.len_bytes();
        if at < len && self.source.byte(at) == b'\t' {
            return 1;
        }
        (at..len.min(at + INDENT_SPACES))
            .take_while(|&index| self.source.byte(index) == b' ')
            .count()
    }

    /// Start offsets of the physical lines `range` touches, in order: the
    /// block lines the engine attributes to the caret or selection (a setext
    /// heading or other multi-line block counts with all its lines).
    fn touched_line_starts(&self, range: DisplayRange) -> Vec<usize> {
        let lines = if range.start == range.end {
            self.projection.caret_block_lines(range)
        } else {
            self.projection.view_block_lines(range)
        };
        // A fence's own lines are not text lines: the caret at the end of a
        // code body is attributed to the closer too, and a tab there would
        // unclose the block. They count only when no text line is touched
        // (an empty code block).
        let is_text = |line: &crate::inline::blocks::BlockLine| {
            line.fence.as_ref().is_none_or(|fence| {
                fence.body.start <= line.source.start && line.source.start < fence.body.end
            })
        };
        let only_fence = !lines.iter().any(is_text);
        let mut starts: Vec<usize> = lines
            .iter()
            .filter(|line| only_fence || is_text(line))
            .flat_map(|line| {
                if line.bodies.len() > 1 || line.underline.is_some() {
                    line.bodies
                        .iter()
                        .chain(line.underline.iter())
                        .map(|physical| physical.source.start)
                        .collect()
                } else {
                    vec![line.source.start]
                }
            })
            .collect();
        starts.sort_unstable();
        starts.dedup();
        starts
    }
}
