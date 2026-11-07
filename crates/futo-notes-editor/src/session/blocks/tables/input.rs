//! Clearing an edge cell must not turn its separator into an outer border.
use super::*;

impl EditorSession {
    pub(in crate::session) fn input_clearing_table_edge(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        plan: &crate::inline::Plan,
        work: &mut crate::inline::references::ReferenceWork,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<(ViewChange, InputMapping)>, EditorError> {
        if range.start == range.end
            || !plan
                .inserted
                .bytes()
                .all(|byte| matches!(byte, b' ' | b'\t'))
        {
            return Ok(None);
        }
        // Look only through edge padding. Ordinary deletion in a cell or a
        // long paragraph never materializes the physical line or table.
        let mut before = self.source.bytes_at(plan.range.start);
        let previous = loop {
            let byte = before.prev();
            work.parsed += usize::from(byte.is_some());
            if !matches!(byte, Some(b' ' | b'\t')) {
                break byte;
            }
        };
        let next = self.source.bytes_at(plan.range.end).find(|byte| {
            work.parsed += 1;
            !matches!(byte, b' ' | b'\t')
        });
        let boundary = |byte| matches!(byte, None | Some(b'\r' | b'\n'));
        if !((boundary(previous) && (boundary(next) || next == Some(b'|')))
            || (previous == Some(b'|') && boundary(next)))
        {
            return Ok(None);
        }
        let Some((window, (row, column))) = self.table_cell_target_counted(range, &mut work.parsed)
        else {
            return Ok(None);
        };
        let line = window.layout.row_line(row);
        let raw = window.absolute(line.cells[column].clone());
        if plan.range.start < raw.start || plan.range.end > raw.end {
            return Ok(None);
        }
        let leading = column == 0 && line.lead.is_none();
        let trailing = column + 1 == line.cells.len() && line.trail.is_none();
        if !leading && !trailing {
            return Ok(None);
        }

        // These offsets belong to the original table window, never to an
        // equal-looking cell or a provisional display generation.
        let mut splices = vec![Splice {
            at: plan.range.start - window.base,
            remove: plan.range.end - plan.range.start,
            text: plan.inserted.clone(),
        }];
        if leading {
            splices.push(Splice {
                at: line.start,
                remove: 0,
                text: "|".into(),
            });
        }
        if trailing {
            splices.push(Splice {
                at: line.end,
                remove: 0,
                text: "|".into(),
            });
        }
        splices.sort_by_key(|splice| (splice.at, splice.remove));
        let (footprint, replacement) =
            table::combine(&window.text, &splices).ok_or(EditorError::InvalidRange)?;
        let after = table::apply(&window.text, &splices);
        let layout = Layout::find(&after, window.layout.lines[0].start)
            .ok_or(EditorError::UnrepresentableFormat)?;
        if layout.columns != window.layout.columns || layout.rows() != window.layout.rows() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let raw = layout
            .row_line(row)
            .cells
            .get(column)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let content = Layout::content(&after, raw);
        if !content.is_empty() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let caret = window.base + content.start;

        // Retained padding is transported by the actual ordered splices.
        // Deleted cell text has no retained identity; other cells stay outside
        // this footprint, including duplicates and differently spelled entities.
        let mut bodies = Vec::new();
        let mut old = footprint.start;
        let mut new = window.base + old;
        let mut input_start = new;
        for splice in &splices {
            if old < splice.at {
                bodies.push(crate::inline::references::RetainedBody {
                    before: window.base + old..window.base + splice.at,
                    after: new..new + splice.at - old,
                });
            }
            new += splice.at - old;
            if splice.remove > 0 {
                input_start = new;
            }
            new += splice.text.len();
            old = splice.at + splice.remove;
        }
        let (retained, correspondence_work) =
            crate::inline::SourceCorrespondence::from_bodies(&bodies)?;
        let edit = self.prepare_source(
            expected,
            SourceRange {
                start: SourceOffset(window.base + footprint.start),
                end: SourceOffset(window.base + footprint.end),
            },
            &replacement,
        )?;
        let affinity = self.input_affinity(range);
        let mut change = self.commit_prepared_block_with_pending(
            edit.clone(),
            BlockSelection::Source(caret),
            Some(HistoryInput {
                range,
                inserted,
                action,
            }),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, Some(plan.formats.clone()), affinity);
        let input_display = if inserted.is_empty() {
            self.selection()
        } else {
            self.display_range(input_start..input_start + inserted.len())
        };
        let mapping = InputMapping::from_source(
            range,
            inserted.len(),
            &edit,
            retained,
            false,
            input_display,
            plan.split_retirement.clone(),
        );
        change.work.materialized_source_bytes +=
            after.len() + replacement.len() + plan.materialized;
        change.work.parsed_source_bytes += after.len() + plan.parsed;
        change.work.link_metadata_items += correspondence_work + plan.link_metadata_items;
        change.work.link_copied_bytes += plan.link_copied_bytes;
        Ok(Some((change, mapping)))
    }
}
