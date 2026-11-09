//! Code indentation is a shared key intent, independent of renderer focus.
use super::*;
use crate::inline::fences::Fence;

struct IndentEdit {
    source: usize,
    display: usize,
    removed: usize,
    /// Spaces written before the tab: an empty code line in a list item has
    /// no indentation of its own, and a tab at column zero would end the line's
    /// membership in the item's code.
    pad: usize,
}

impl EditorSession {
    /// Whether `line` is code text of `fence`: a body line, an empty one too,
    /// never its opener or closer (a tab there would end the fence).
    fn is_fence_text(line: &crate::inline::blocks::BlockLine, fence: &Fence) -> bool {
        fence.body.start <= line.source.start
            && fence
                .closer
                .as_ref()
                .is_none_or(|closer| !line.source.contains(&closer.start))
    }

    /// Bytes an Outdent removes from a code line: a tab, else up to two spaces.
    fn code_outdent_width(&self, line: &crate::inline::blocks::BlockLine) -> usize {
        let lead = self.source.byte_slice(line.content.clone());
        if lead.bytes().next() == Some(b'\t') {
            1
        } else {
            lead.bytes().take(2).take_while(|&ch| ch == b' ').count()
        }
    }

    /// How many of `lines` an Indent (or, with `outdent`, an Outdent that has
    /// something to remove) changes in `fence`.
    pub(in crate::session) fn fence_text_lines(
        &self,
        lines: &[crate::inline::blocks::BlockLine],
        fence: &Fence,
        outdent: bool,
    ) -> usize {
        lines
            .iter()
            .filter(|line| Self::is_fence_text(line, fence))
            .filter(|line| !outdent || self.code_outdent_width(line) > 0)
            .count()
    }

    /// The Tab key (`key`) writes two spaces at a collapsed caret or at each
    /// selected line; the Indent button writes one tab at each touched code
    /// line. Shift+Tab and Outdent remove a tab, else up to two spaces.
    pub(in crate::session) fn fence_indent(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        outdent: bool,
        key: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let lines = self.projection.block_lines(range);
        let Some(fence) = lines.first().and_then(|line| line.fence.as_ref()) else {
            return Ok(None);
        };
        if lines.iter().any(|line| {
            line.fence
                .as_ref()
                .is_none_or(|other| other.whole != fence.whole)
        }) {
            return Ok(None);
        }
        if !outdent && range.start == range.end && key {
            return self.fence_input(expected, range, "  ", crate::InputAction::Isolated, accept);
        }
        let edits: Vec<_> = lines
            .iter()
            .filter(|line| Self::is_fence_text(line, fence))
            .filter_map(|line| {
                let removed = if outdent {
                    self.code_outdent_width(line)
                } else {
                    0
                };
                (!outdent || removed > 0).then(|| IndentEdit {
                    source: line.content.start,
                    display: self.projection.display_at(line.content.start),
                    removed,
                    pad: if outdent || key {
                        0
                    } else {
                        line.list
                            .as_ref()
                            .filter(|list| {
                                list.quote_depth == 0
                                    && line.source.start == line.content.start
                                    && line.content.is_empty()
                            })
                            .map_or(0, |list| list.content_column)
                    },
                })
            })
            .collect();
        let Some(first) = edits.first() else {
            return Ok(None);
        };
        let last = edits.last().unwrap();
        let footprint = first.source..last.source + last.removed;
        let mut output = self.source.byte_slice(footprint.clone()).to_string();
        let input = match (outdent, key) {
            (true, _) => "",
            (false, true) => "  ",
            (false, false) => "\t",
        };
        for edit in edits.iter().rev() {
            output.replace_range(
                edit.source - footprint.start..edit.source + edit.removed - footprint.start,
                &format!("{}{input}", " ".repeat(edit.pad)),
            );
        }
        let map = |position: usize| {
            let mut result = position;
            for edit in &edits {
                if position >= edit.display + edit.removed {
                    result = result + input.len() - edit.removed;
                } else if edit.display < position {
                    result -= position - edit.display;
                }
            }
            DisplayOffset(result)
        };
        let selection = DisplayRange {
            start: map(range.start.0),
            end: map(range.end.0),
        };
        self.commit_block_edit(
            expected,
            footprint,
            &output,
            BlockSelection::Display(selection),
            None,
            accept,
        )
        .map(Some)
    }
}
