//! Full-list lifting across quotes uses original canonical item fragments.
use super::indent_source::{OwnedPrefixShift, PhysicalPrefixShift};
use super::*;
use crate::inline::{
    blocks::{ListCommandLine, SourcePrefix},
    ListLine,
};
use std::{collections::BTreeMap, ops::Range};

struct Group {
    root: ListLine,
    removed: ListLine,
}

mod cuts;
mod emit;

impl EditorSession {
    pub(super) fn lift_crossquote_list(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        lines: &[ListCommandLine],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let selected = lines[0]
            .list
            .as_ref()
            .ok_or(EditorError::UnrepresentableFormat)?;
        let (items, planning_bytes, _) = self
            .projection
            .list_items_at(&self.source, selected.marker.start);
        let mut groups: Vec<Group> = Vec::new();
        for item in &items {
            crate::inline::visit_container();
            if item.item.start <= selected.marker.start && selected.marker.start < item.item.end {
                if let Some(group) = groups
                    .last_mut()
                    .filter(|group| group.root.quote_depth == item.quote_depth)
                {
                    group.removed = item.clone();
                } else {
                    groups.push(Group {
                        root: item.clone(),
                        removed: item.clone(),
                    });
                }
            }
        }
        if let Some(change) = self.try_lift_crossquote_header(
            expected,
            range,
            lines,
            &groups,
            planning_bytes,
            accept,
        )? {
            return Ok(Some(change));
        }
        let cuts = self.plan_crossquote_cuts(&groups, &items)?;
        let emit::CrossquoteEdits {
            mut edits,
            parsed,
            mut materialized,
        } = self.emit_crossquote_cuts(cuts)?;
        materialized += self.add_shared_root_frame(lines, &groups, &mut edits)?;
        let parsed = planning_bytes + parsed;
        materialized += planning_bytes;
        edits.sort_by_key(|(range, _)| range.start);
        let Some(first) = edits.first() else {
            return Ok(None);
        };
        let footprint = first.0.start..edits.last().unwrap().0.end;
        let original = self.source.byte_slice(footprint.clone()).to_string();
        materialized += original.len();
        let relative: Vec<_> = edits
            .iter()
            .map(|(range, text)| {
                (
                    range.start - footprint.start..range.end - footprint.start,
                    text.clone(),
                )
            })
            .collect();
        materialized += relative.iter().map(|(_, text)| text.len()).sum::<usize>();
        let output = super::transaction::spell_edits(&original, &relative)?;
        let (selected, preview_work) =
            self.preview_header_selection(range, footprint.clone(), &relative, &output, None)?;
        let formats = (range == self.selection)
            .then(|| self.pending_formats.clone())
            .flatten();
        let affinity = self.input_affinity(range);
        let mut change = self.commit_block_edit(
            expected,
            footprint,
            &output,
            BlockSelection::Display(selected),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        change.work.parsed_source_bytes += parsed;
        change.work.materialized_source_bytes += materialized + output.len();
        accumulate_planning_work(&mut change.work, preview_work);
        Ok(Some(change))
    }

    /// A complete shared physical header chain has one representable root
    /// empty paragraph. Leading empty paragraphs inside quotes are not written.
    fn add_shared_root_frame(
        &self,
        lines: &[ListCommandLine],
        groups: &[Group],
        edits: &mut [(Range<usize>, String)],
    ) -> Result<usize, EditorError> {
        let first = &lines[0];
        if lines.len() != 1
            || groups.len() < 2
            || first.quote_depth != groups.len()
            || first.code
            || first.heading > 0
            || first.task.is_some()
        {
            return Ok(0);
        }
        for (index, group) in groups.iter().enumerate() {
            crate::inline::visit_container();
            let item = &group.root;
            if item.depth != index + 1
                || item.checked.is_some()
                || item.quote_depth != index
                || item.marker != group.removed.marker
                || item.marker.start < first.source.start
                || item.marker.end > first.content.start
                || item.item.end > first.source.end
                || index == 0 && item.marker.start != first.source.start
            {
                return Ok(0);
            }
        }
        let ending = self
            .source
            .byte_slice(first.content.end..first.source.end)
            .to_string();
        let newline = if ending.ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let (_, value) = edits
            .iter_mut()
            .find(|(range, _)| {
                crate::inline::visit_container();
                *range == (first.source.start..first.content.start)
            })
            .ok_or(EditorError::UnrepresentableFormat)?;
        value.insert_str(0, newline);
        // insert_str moves the retained prefix and copies this one new EOL.
        Ok(ending.len() + value.len())
    }

    fn try_lift_crossquote_header(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        lines: &[ListCommandLine],
        groups: &[Group],
        planning_bytes: usize,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let selected = lines[0]
            .list
            .as_ref()
            .ok_or(EditorError::UnrepresentableFormat)?;
        let first = &lines[0];
        if groups.len() == 2
            && lines.len() == 1
            && selected.depth == 2
            && selected.quote_depth == 1
            && first.quote_depth == 1
            && groups[0].root.depth == 1
            && groups[0].root.quote_depth == 0
            && groups[0].root.marker.start == first.source.start
            && groups[0].root.item.end <= first.source.end
            && selected.item.end <= first.source.end
            && !first.code
            && first.heading == 0
            && first.task.is_none()
        {
            let prefix = self
                .source
                .byte_slice(first.source.start..first.content.start)
                .to_string();
            let ending = self
                .source
                .byte_slice(first.content.end..first.source.end)
                .to_string();
            let newline = if ending.ends_with("\r\n") {
                "\r\n"
            } else {
                "\n"
            };
            let mut output = newline.to_owned();
            let mut at = 0;
            for group in groups {
                crate::inline::visit_container();
                let item = &group.removed;
                let marker = item.marker.start - first.source.start;
                if marker < at || item.indent > prefix.len() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                output.push_str(&prefix[at..marker]);
                at = item.indent;
            }
            output.push_str(&prefix[at..]);
            let mut change = self.commit_planned_prefix(
                expected,
                range,
                first.source.start..first.content.start,
                &output,
                HeaderShape::Plain {
                    quotes: 1,
                    earlier: None,
                },
                accept,
            )?;
            change.work.parsed_source_bytes += planning_bytes;
            change.work.materialized_source_bytes +=
                planning_bytes + prefix.len() + ending.len() + output.len();
            return Ok(Some(change));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod work_tests;
