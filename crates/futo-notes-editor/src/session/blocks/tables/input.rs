//! Clearing an edge cell must not turn its separator into an outer border.
use super::*;

struct InputRow {
    start: usize,
    text: String,
    line: table::Line,
    column: usize,
}

impl EditorSession {
    /// The greedy owner comes from retained canonical scan facts. Only the
    /// addressed physical row is materialized; explicit table commands keep
    /// their existing complete-layout path.
    fn input_row(
        &self,
        range: DisplayRange,
        work: &mut crate::inline::references::ReferenceWork,
    ) -> Option<InputRow> {
        let (start, end) = self.table_source_span(range);
        if !self.table_at_root(start) {
            return None;
        }
        if start == self.source.len_bytes() && self.source.bytes_at(start).prev() == Some(b'\n') {
            return None;
        }
        let row_start = self.table_line_start(start);
        let (row_end, next) = self.table_line_end(row_start);
        if end > row_end {
            return None;
        }
        let (state, visits) = self.projection.rows.table_state_at(start);
        work.items += visits;
        let header = match state {
            table::State::Inside(header) => header,
            table::State::Searching(Some(header))
                if header.start == row_start && next < self.source.len_bytes() =>
            {
                let (state, visits) = self.projection.rows.table_state_at(next);
                work.items += visits;
                match state {
                    table::State::Inside(found) if found == header => header,
                    _ => return None,
                }
            }
            _ => return None,
        };
        // Keep the original root predicate AFTER the greedy winner is chosen.
        if !self.table_at_root(header.start) {
            return None;
        }
        if self.table_line_end(header.start).1 == row_start {
            return None;
        }
        let text = self.source.byte_slice(row_start..row_end).to_string();
        work.parsed += text.len();
        let line = table::row_line(&text);
        let column = line
            .cells
            .iter()
            .position(|raw| row_start + raw.start <= start && end <= row_start + raw.end)?;
        if column >= header.columns {
            return None;
        }
        Some(InputRow {
            start: row_start,
            text,
            line,
            column,
        })
    }

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
        let Some(row) = self.input_row(range, work) else {
            return Ok(None);
        };
        let column = row.column;
        let line = &row.line;
        let raw = &line.cells[column];
        if plan.range.start < row.start + raw.start || plan.range.end > row.start + raw.end {
            return Ok(None);
        }
        let leading = column == 0 && line.lead.is_none();
        let trailing = column + 1 == line.cells.len() && line.trail.is_none();
        if !leading && !trailing {
            return Ok(None);
        }

        // These offsets belong to the original physical row, never to an
        // equal-looking cell or a provisional display generation.
        let mut splices = vec![Splice {
            at: plan.range.start - row.start,
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
            table::combine(&row.text, &splices).ok_or(EditorError::InvalidRange)?;
        let after = table::apply(&row.text, &splices);
        let after_line = table::row_line(&after);
        if after_line.cells.len() != line.cells.len() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let raw = after_line
            .cells
            .get(column)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let content = Layout::content(&after, raw);
        if !content.is_empty() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let caret = row.start + content.start;

        // Retained padding is transported by the actual ordered splices.
        // Deleted cell text has no retained identity; other cells stay outside
        // this footprint, including duplicates and differently spelled entities.
        let mut bodies = Vec::new();
        let mut old = footprint.start;
        let mut new = row.start + old;
        let mut input_start = new;
        for splice in &splices {
            if old < splice.at {
                bodies.push(crate::inline::references::RetainedBody {
                    before: row.start + old..row.start + splice.at,
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
                start: SourceOffset(row.start + footprint.start),
                end: SourceOffset(row.start + footprint.end),
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
