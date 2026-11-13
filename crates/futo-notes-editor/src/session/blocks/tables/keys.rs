//! Table keys and structural commands: one selection move or one accepted edit.
use super::*;

impl EditorSession {
    fn commit_table_splices(
        &mut self,
        expected: Revision,
        window: &Window,
        splices: &[Splice],
        selection: BlockSelection,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let (range, inserted) =
            table::combine(&window.text, splices).ok_or(EditorError::InvalidRange)?;
        let range = window.absolute(range);
        self.commit_block_edit(expected, range, &inserted, selection, None, accept)
    }

    /// Where `(row, column)` sits once `splices` are written, as a source offset.
    fn table_cell_after(
        window: &Window,
        splices: &[Splice],
        row: usize,
        column: usize,
    ) -> Option<usize> {
        let text = table::apply(&window.text, splices);
        let layout = Layout::find(&text, window.layout.lines[0].start)?;
        let line = layout.row_line(row);
        let at = match line.cells.get(column) {
            Some(raw) => Layout::content(&text, raw).start,
            None => line.end,
        };
        Some(window.base + at)
    }

    fn select_cell(
        &mut self,
        expected: Revision,
        window: &Window,
        row: usize,
        column: usize,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<TableOutcome, EditorError> {
        if let Some(content) = window.cell_content(row, column) {
            let range = self.display_range(content);
            return self.select(expected, range).map(TableOutcome::Selected);
        }
        // A short body row gains the cells it lacks, then the caret enters.
        let splices = window.layout.fill_row(row);
        let at = Self::table_cell_after(window, &splices, row, column)
            .ok_or(EditorError::InvalidRange)?;
        self.commit_table_splices(
            expected,
            window,
            &splices,
            BlockSelection::Source(at),
            accept,
        )
        .map(|change| TableOutcome::Edited(Box::new(change)))
    }

    fn append_row(
        &mut self,
        expected: Revision,
        window: &Window,
        column: usize,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<TableOutcome, EditorError> {
        let rows = window.layout.rows();
        let splices = window.layout.insert_row(&window.text, rows - 1, true);
        let at = Self::table_cell_after(window, &splices, rows, column)
            .ok_or(EditorError::InvalidRange)?;
        self.commit_table_splices(
            expected,
            window,
            &splices,
            BlockSelection::Source(at),
            accept,
        )
        .map(|change| TableOutcome::Edited(Box::new(change)))
    }

    /// Tab, Shift+Tab, Enter, Mod+Enter and Shift+Enter with the selection in a
    /// cell. `None` leaves the key to the ordinary paragraph path (outside a
    /// table, across cells, Shift+Tab in the first cell).
    pub fn table_key(
        &mut self,
        expected: Revision,
        key: TableKey,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<TableOutcome>, EditorError> {
        on_next!(self, accept, |e, accept| e
            .press_table_key(expected, key, accept));
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        self.table_key_at(expected, self.selection, key, accept)
    }

    /// Paragraph Enter and Shift+Enter in a cell are the table's keys, so a
    /// line break never splits a row; a move to the cell below is reported
    /// as a selection-only change at the unchanged revision.
    pub(in crate::session) fn cell_enter(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        shift: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let key = if shift {
            TableKey::ShiftEnter
        } else {
            TableKey::Enter
        };
        Ok(match self.table_key_at(expected, range, key, accept)? {
            None => None,
            Some(TableOutcome::Edited(change)) => Some(*change),
            Some(TableOutcome::Selected(moved)) => {
                let at = DisplayRange {
                    start: moved.selection.start,
                    end: moved.selection.start,
                };
                let (projection, work) = self.projection.query_with_work(self.revision, at);
                Some(ViewChange {
                    previous_revision: self.revision,
                    revision: self.revision,
                    range: at,
                    inserted: String::new(),
                    selection: moved.selection,
                    affinity: moved.affinity,
                    projection,
                    work: crate::EditWork {
                        link_metadata_items: work.items,
                        link_copied_bytes: work.copied,
                        ..Default::default()
                    },
                })
            }
        })
    }

    fn table_key_at(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        key: TableKey,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<TableOutcome>, EditorError> {
        let Some((window, (row, column))) = self.table_cell_target_counted(range, &mut 0) else {
            return Ok(None);
        };
        let rows = window.layout.rows();
        let columns = window.layout.columns;
        match key {
            TableKey::Tab => {
                if column + 1 < columns {
                    self.select_cell(expected, &window, row, column + 1, accept)
                } else if row + 1 < rows {
                    self.select_cell(expected, &window, row + 1, 0, accept)
                } else {
                    self.append_row(expected, &window, 0, accept)
                }
            }
            TableKey::ShiftTab => {
                if column > 0 {
                    self.select_cell(expected, &window, row, column - 1, accept)
                } else if row > 0 {
                    self.select_cell(expected, &window, row - 1, columns - 1, accept)
                } else {
                    return Ok(None);
                }
            }
            TableKey::Enter => {
                if row + 1 < rows {
                    self.select_cell(expected, &window, row + 1, column, accept)
                } else {
                    self.append_row(expected, &window, column, accept)
                }
            }
            TableKey::ModEnter => self
                .exit_table(expected, &window, accept)
                .map(|change| TableOutcome::Edited(Box::new(change))),
            TableKey::ShiftEnter => {
                let (start, end) = self.table_source_span(range);
                let selection = BlockSelection::Source(start + "<br>".len());
                self.commit_block_edit(expected, start..end, "<br>", selection, None, accept)
                    .map(|change| TableOutcome::Edited(Box::new(change)))
            }
        }
        .map(Some)
    }

    /// A blank line and an empty line after the table; the caret takes the
    /// empty one, so typed text cannot join the table or the block after it.
    fn exit_table(
        &mut self,
        expected: Revision,
        window: &Window,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let last = window.layout.lines.last().unwrap();
        let eol = window.layout.eol(&window.text, last);
        let (at, text, caret) = if last.next == last.end {
            let at = window.base + last.end;
            (at, format!("{eol}{eol}"), at + 2 * eol.len())
        } else {
            let at = window.base + last.next;
            let rest = at < self.source.len_bytes();
            let text = if rest {
                format!("{eol}{eol}")
            } else {
                eol.to_owned()
            };
            (at, text, at + eol.len())
        };
        self.commit_block_edit(
            expected,
            at..at,
            &text,
            BlockSelection::Source(caret),
            None,
            accept,
        )
    }

    /// Structural command addressed by any range inside the target cell.
    /// `None`: not in a cell, or the command is disabled for it (header row
    /// deletion, a table's last body row or column).
    pub fn table_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: TableCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        on_next!(self, accept, |e, accept| e
            .run_table_command(expected, range, command, accept));
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        self.validate_range(range)?;
        let Some((window, Some((row, column)))) = self.table_target(range) else {
            return Ok(None);
        };
        let layout = &window.layout;
        let controls = layout.controls(row);
        let (allowed, splices, focus) = match command {
            TableCommand::InsertRowAbove => (
                controls.insert_row_above,
                layout.insert_row(&window.text, row, false),
                (row + 1, column),
            ),
            TableCommand::InsertRowBelow => (
                controls.insert_row_below,
                layout.insert_row(&window.text, row, true),
                (row, column),
            ),
            TableCommand::DeleteRow => (
                controls.delete_row,
                if controls.delete_row {
                    layout.delete_row(row)
                } else {
                    Vec::new()
                },
                (row.min(layout.rows() - 2), column),
            ),
            TableCommand::InsertColumnLeft => (
                controls.insert_column_left,
                layout.insert_column(column),
                (row, column + 1),
            ),
            TableCommand::InsertColumnRight => (
                controls.insert_column_right,
                layout.insert_column(column + 1),
                (row, column),
            ),
            TableCommand::DeleteColumn => (
                controls.delete_column,
                if controls.delete_column {
                    layout.delete_column(&window.text, column)
                } else {
                    Vec::new()
                },
                (row, column.min(layout.columns.saturating_sub(2))),
            ),
        };
        if !allowed || splices.is_empty() {
            return Ok(None);
        }
        let deleting = matches!(
            command,
            TableCommand::DeleteRow | TableCommand::DeleteColumn
        );
        let raw = window.absolute(layout.row_line(row).cells[column].clone());
        let (start, end) = self.table_source_span(self.selection);
        let selection = if !deleting && raw.start <= start && end <= raw.end {
            // The focused cell survives: keep the caret or selection in it.
            let shift = |at: usize| {
                let rel = at - window.base;
                let moved: usize = splices
                    .iter()
                    .filter(|splice| splice.at + splice.remove <= rel)
                    .map(|splice| splice.text.len())
                    .sum::<usize>()
                    - splices
                        .iter()
                        .filter(|splice| splice.at + splice.remove <= rel)
                        .map(|splice| splice.remove)
                        .sum::<usize>();
                at + moved
            };
            BlockSelection::SourceRange(shift(start)..shift(end))
        } else {
            BlockSelection::Source(
                Self::table_cell_after(&window, &splices, focus.0, focus.1)
                    .ok_or(EditorError::InvalidRange)?,
            )
        };
        self.commit_table_splices(expected, &window, &splices, selection, accept)
            .map(Some)
    }
}
