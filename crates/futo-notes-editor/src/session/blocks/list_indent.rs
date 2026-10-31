//! Container indentation uses canonical item ownership and content columns.
use super::*;

struct ContainerPlan {
    head: usize,
    marker_at: usize,
    prefix_end: usize,
    column: usize,
    marker: String,
    padding: String,
    body_delta: isize,
    shared_line: bool,
    display_anchor: usize,
}

impl EditorSession {
    pub(super) fn indent_list(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let lines = self.selected_block_lines(range);
        let Some(first) = lines.first().filter(|line| !line.code) else {
            return Ok(None);
        };
        let Some(item) = &first.list else {
            return Ok(None);
        };
        if first.quote_depth > item.quote_depth {
            return Ok(None);
        }
        let (width, add) = if command == BlockCommand::Indent {
            let Some(column) = item.previous_content_column else {
                return Ok(None);
            };
            let Some(width) = column
                .checked_sub(item.marker_column)
                .filter(|width| *width > 0)
            else {
                return Ok(None);
            };
            (width, true)
        } else {
            let Some(column) = item.parent_marker_column else {
                return self.lift_current_list(expected, range, accept);
            };
            (item.marker_column - column, false)
        };
        let start = self
            .source
            .line_to_byte(self.source.byte_to_line(item.marker.start));
        let end = lines
            .iter()
            .filter_map(|line| {
                crate::inline::visit_container();
                line.list.as_ref()
            })
            .filter(|other| other.owner == item.owner)
            .map(|other| other.item.end)
            .max()
            .unwrap_or(item.item.end);
        let raw = self.source.byte_slice(start..end).to_string();
        let (plans, copied) = self.plan_list_indentation(&lines, item, add)?;
        let materialized = raw.len() + copied;
        let output = self.emit_list_indentation(start, &raw, item.quote_depth, width, &plans);
        let mut selection = range;
        for endpoint in [&mut selection.start.0, &mut selection.end.0] {
            let opening = *endpoint;
            *endpoint += plans
                .iter()
                .filter(|plan| plan.shared_line && plan.display_anchor <= opening)
                .count();
        }
        let formats = (range == self.selection)
            .then(|| self.pending_formats.clone())
            .flatten();
        let affinity = self.input_affinity(range);
        let mut change = self.commit_block_edit(
            expected,
            start..end,
            &output,
            BlockSelection::Display(selection),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        change.work.materialized_source_bytes += materialized;
        Ok(Some(change))
    }
}

#[path = "list_indent_plan.rs"]
mod plan;

#[cfg(test)]
mod work_tests {
    use crate::*;

    #[test]
    fn distant_unrelated_paragraphs_do_not_enter_container_parser_or_metadata_work() {
        let mut measurements = Vec::new();
        for paragraphs in [1, 20_000] {
            let prefix = "foreign\n\n".repeat(paragraphs);
            let raw = format!("{prefix}\nanchor\n\n- a\n- b\n\nend");
            let shown = format!("{prefix}\nanchor\n\na\nb\n\nend");
            let expected = format!("{prefix}\nanchor\n\n- a\n  - b\n\nend");
            let at = prefix.len() + 11;
            let selected = DisplayRange {
                start: DisplayOffset(at),
                end: DisplayOffset(at + 1),
            };
            let mut session = EditorSession::open(&raw);
            assert_eq!(session.display_text(), shown);
            session.select(Revision(0), selected).unwrap();
            crate::inline::CONTAINER_METADATA_VISITS.with(|visits| visits.set(0));
            let change = session
                .block_command(Revision(0), selected, BlockCommand::Indent, &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|visits| visits.get());
            let mut view = shown.clone();
            view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(view, shown);
            assert_eq!(session.source_text(), expected);
            assert_eq!(session.selection(), selected);
            assert!(visits > 0 && visits < 4096, "{visits}");
            assert!(change.work.parsed_source_bytes > 0 && change.work.parsed_source_bytes < 4096);
            assert!(
                change.work.materialized_source_bytes > 0
                    && change.work.materialized_source_bytes < 4096
            );
            measurements.push((
                change.work.parsed_source_bytes,
                change.work.materialized_source_bytes,
                visits,
            ));
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(session.source_text(), raw);
        }
        // Parser/materialization footprints stay identical; the retained
        // row-tree metadata lookup may grow logarithmically with note size.
        assert_eq!(measurements[0].0, measurements[1].0);
        assert_eq!(measurements[0].1, measurements[1].1);
    }
}
