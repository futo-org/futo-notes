//! Code indentation is a shared key intent, independent of renderer focus.
use super::*;

struct IndentEdit {
    source: usize,
    display: usize,
    removed: usize,
}

impl EditorSession {
    pub(in crate::session) fn fence_indent(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        outdent: bool,
        insert_at_caret: bool,
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
        if !outdent && range.start == range.end && (insert_at_caret || fence.body.is_empty()) {
            return self.fence_input(expected, range, "  ", crate::InputAction::Isolated, accept);
        }
        let edits: Vec<_> = lines
            .iter()
            .filter(|line| {
                fence.body.start <= line.source.start && line.source.start < fence.body.end
            })
            .filter_map(|line| {
                let removed = if outdent {
                    self.source
                        .byte_slice(line.content.clone())
                        .bytes()
                        .take(2)
                        .take_while(|&ch| ch == b' ')
                        .count()
                } else {
                    0
                };
                (!outdent || removed > 0).then(|| IndentEdit {
                    source: line.content.start,
                    display: self.projection.display_at(line.content.start),
                    removed,
                })
            })
            .collect();
        let Some(first) = edits.first() else {
            return Ok(None);
        };
        let last = edits.last().unwrap();
        let footprint = first.source..last.source + last.removed;
        let mut output = self.source.byte_slice(footprint.clone()).to_string();
        let input = if outdent { "" } else { "  " };
        for edit in edits.iter().rev() {
            output.replace_range(
                edit.source - footprint.start..edit.source + edit.removed - footprint.start,
                input,
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
