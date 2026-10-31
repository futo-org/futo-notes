//! Command-local plans for empty list parents sharing a quoted body.
use super::*;

mod full;
mod nearest;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum FrameAction {
    Outdent,
    Backspace,
    Text,
}

pub(super) enum FramePlan<'a> {
    Prefix {
        footprint: std::ops::Range<usize>,
        text: String,
        shape: HeaderShape<'a>,
        copied: usize,
    },
    Paragraph {
        footprint: std::ops::Range<usize>,
        edits: Vec<(std::ops::Range<usize>, String)>,
        shape: HeaderShape<'a>,
        copied: usize,
    },
}

impl FramePlan<'_> {
    fn finish(
        self,
        session: &mut EditorSession,
        expected: Revision,
        range: DisplayRange,
        planning: usize,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let copied = match &self {
            Self::Prefix { copied, .. } | Self::Paragraph { copied, .. } => *copied,
        };
        let mut change = match self {
            Self::Prefix {
                footprint,
                text,
                shape,
                ..
            } => session.commit_planned_prefix(expected, range, footprint, &text, shape, accept)?,
            Self::Paragraph {
                footprint,
                edits,
                shape,
                ..
            } => {
                session.commit_planned_header(expected, range, footprint, &edits, shape, accept)?
            }
        };
        change.work.parsed_source_bytes += planning;
        change.work.materialized_source_bytes += planning + copied;
        Ok(change)
    }
}

impl EditorSession {
    pub(super) fn shared_prefix_frames(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        action: FrameAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let lines = self.selected_list_lines(range);
        let [line] = lines.as_slice() else {
            return Ok(None);
        };
        let Some(list) = line.list.as_ref() else {
            return Ok(None);
        };
        // Nearest paragraph framing owns only canonical physical body rows;
        // other item blocks and full-toolbar lifting retain their own paths.
        if line.content.is_empty()
            || line.code
            || line.heading != 0
            || list.checked.is_some()
            || !list.first
            || line.quote_depth == 0
            || (action != FrameAction::Text && line.quote_depth <= list.quote_depth)
            || (action == FrameAction::Backspace
                && (range.start != range.end
                    || range.start.0 != self.projection.display_at(line.content.start)))
        {
            return Ok(None);
        }
        let multiline = list.item.end > line.source.end;
        if action == FrameAction::Text && !multiline {
            return Ok(None);
        }
        if multiline && action != FrameAction::Text && list.depth != 1 {
            return Ok(None);
        }
        let (items, planning, _, paragraph) = self.projection.list_items_and_paragraph_at(
            &self.source,
            list.marker.start,
            multiline.then_some(line.content.start),
        );
        let paragraph = if multiline {
            let Some(paragraph) = paragraph.filter(|paragraph| {
                paragraph.start == line.content.start && paragraph.end > line.source.end
            }) else {
                return Ok(None);
            };
            Some(paragraph)
        } else {
            None
        };
        let plan = if action == FrameAction::Text {
            self.plan_full_prefix_frame(line, &items, paragraph.unwrap())?
        } else {
            self.plan_nearest_prefix_frame(line, &items, paragraph, action)?
        };
        plan.map(|plan| plan.finish(self, expected, range, planning, accept))
            .transpose()
    }
}

#[cfg(test)]
mod work_tests;
