use super::progress::{unit_display, unit_source, ProgressState};
use super::*;

impl ProgressState {
    fn unit_at_display(
        &self,
        display: &Rope,
        at: DisplayOffset,
        visits: &mut usize,
    ) -> Option<usize> {
        let line = display.byte_to_line(at.0).checked_sub(self.frame_lines)?;
        let index = self
            .certificate
            .units
            .partition_point(|unit| {
                *visits += 1;
                unit.display_lines.start <= line
            })
            .checked_sub(1)?;
        let unit = &self.certificate.units[index];
        *visits += 1;
        (line <= unit.display_lines.end).then_some(index)
    }

    pub(super) fn code_source_at(
        &self,
        source: &Rope,
        display: &Rope,
        at: DisplayOffset,
        visits: &mut usize,
    ) -> Option<(SourceOffset, std::ops::Range<usize>)> {
        if self.restore {
            return None;
        }
        let index = self.unit_at_display(display, at, visits)?;
        if !self.code[index] {
            return None;
        }
        let unit = &self.certificate.units[index];
        let last = index + 1 == self.certificate.units.len();
        let shown = unit_display(display, unit, last, self.frame_lines);
        if at.0 < shown.start.0 || shown.end.0 < at.0 {
            return None;
        }
        let range = unit_source(source, unit, last);
        Some((SourceOffset(range.start + at.0 - shown.start.0), range))
    }

    pub(super) fn display_at_source(
        &self,
        source: &Rope,
        display: &Rope,
        at: SourceOffset,
        visits: &mut usize,
    ) -> Option<DisplayOffset> {
        let line = source.byte_to_line(at.0);
        let index = self
            .certificate
            .units
            .partition_point(|unit| {
                *visits += 1;
                unit.source_lines.start <= line
            })
            .checked_sub(1)?;
        *visits += 1;
        if !self.code[index] {
            return None;
        }
        let unit = &self.certificate.units[index];
        let source_start = source.line_to_byte(unit.source_lines.start);
        let display_start = display.line_to_byte(unit.display_lines.start + self.frame_lines);
        Some(DisplayOffset(display_start + at.0 - source_start))
    }
}

impl BoundedEditorSession {
    pub(super) fn reproject_code_selection(&mut self) -> usize {
        let SourceSelection::Exact(source) = self.history_selection else {
            return 0;
        };
        let mut visits = 0;
        let mut map = |point: SourcePoint| {
            if self.code.body.start <= point.source.0 && point.source.0 <= self.code.body.end {
                Some(DisplayOffset(
                    self.code.display.start + point.source.0 - self.code.body.start,
                ))
            } else {
                self.progress.as_ref()?.display_at_source(
                    &self.engine.source,
                    &self.display,
                    point.source,
                    &mut visits,
                )
            }
        };
        let start = map(source.start);
        let end = if source.start == source.end {
            start
        } else {
            map(source.end)
        };
        let (Some(start), Some(end)) = (start, end) else {
            return visits;
        };
        let opening = self.engine.selection;
        self.engine.selection = DisplayRange { start, end };
        if let Some(run) = &mut self.engine.typing {
            run.rebase_selection(opening, self.engine.selection);
        }
        visits
    }

    /// A current display selection chooses its unit through retained Rope
    /// indexes. Pending code is certified directly, without scanning its prefix.
    pub fn select_bounded(
        &mut self,
        cursor: BoundedCursor,
        range: DisplayRange,
        affinity: Affinity,
    ) -> Result<BoundedProgress, BoundedError> {
        let mut work = BoundedWork::default();
        let result = self.select_bounded_with_work(cursor, range, affinity, &mut work);
        self.last_operation = result.as_ref().map_or(work, BoundedProgress::work);
        result
    }

    fn select_bounded_with_work(
        &mut self,
        cursor: BoundedCursor,
        range: DisplayRange,
        affinity: Affinity,
        work: &mut BoundedWork,
    ) -> Result<BoundedProgress, BoundedError> {
        if cursor != self.cursor() {
            return Err(BoundedError::StaleCursor);
        }
        if range.start.0 > range.end.0 {
            return Err(BoundedError::Editor(EditorError::InvalidRange));
        }
        for at in [range.start.0, range.end.0] {
            let index = self
                .display
                .try_byte_to_char(at)
                .map_err(|_| BoundedError::Editor(EditorError::InvalidRange))?;
            if self.display.char_to_byte(index) != at {
                return Err(BoundedError::Editor(EditorError::InvalidRange));
            }
        }
        let generation = self
            .generation
            .checked_add(1)
            .ok_or(BoundedError::Editor(EditorError::RevisionExhausted))?;
        let in_body =
            self.code.display.start <= range.start.0 && range.end.0 <= self.code.display.end;
        let mut frame = None;
        let mut selected_unit = None;
        let exact = if in_body {
            let point = |at: DisplayOffset| SourcePoint {
                source: SourceOffset(self.code.body.start + at.0 - self.code.display.start),
                within: 0,
                atom: None,
            };
            ExactSelection {
                start: point(range.start),
                end: point(range.end),
            }
        } else {
            let progress = self.progress.as_ref().ok_or(BoundedError::Unsupported)?;
            if !progress.changed || progress.restore {
                return Err(BoundedError::Unsupported);
            }
            let index = progress
                .unit_at_display(&self.display, range.start, &mut work.metadata_items)
                .ok_or(BoundedError::Unsupported)?;
            selected_unit = Some(index);
            let unit = &progress.certificate.units[index];
            let last = index + 1 == progress.certificate.units.len();
            let shown = unit_display(&self.display, unit, last, progress.frame_lines);
            if range.end.0 > shown.end.0 {
                return Err(BoundedError::Unsupported);
            }
            let source = unit_source(&self.engine.source, unit, last);
            if progress.code[index] {
                let point = |at: DisplayOffset| SourcePoint {
                    source: SourceOffset(source.start + at.0 - shown.start.0),
                    within: 0,
                    atom: None,
                };
                ExactSelection {
                    start: point(range.start),
                    end: point(range.end),
                }
            } else {
                let original = DisplayRange {
                    start: DisplayOffset(unit.display.start + range.start.0 - shown.start.0),
                    end: DisplayOffset(unit.display.start + range.end.0 - shown.start.0),
                };
                let (mut exact, visits) =
                    self.engine.projection.source_selection(original, affinity);
                work.metadata_items += visits;
                for point in [&mut exact.start, &mut exact.end] {
                    if point.atom.is_some()
                        || point.source.0 < unit.source.start
                        || unit.source.end < point.source.0
                    {
                        return Err(BoundedError::Unsupported);
                    }
                    point.source.0 = source.start + point.source.0 - unit.source.start;
                }
                frame = Some(self.convert_unit(cursor, generation, index)?);
                exact
            }
        };
        // The selected unit owns both endpoints, including its trailing
        // boundary. A global lookup there would choose the next pending unit.
        let (source_start, display_start) = if let Some(index) = selected_unit {
            let progress = self.progress.as_ref().unwrap();
            let unit = &progress.certificate.units[index];
            let last = index + 1 == progress.certificate.units.len();
            (
                unit_source(&self.engine.source, unit, last).start,
                unit_display(&self.display, unit, last, progress.frame_lines)
                    .start
                    .0,
            )
        } else {
            (self.code.body.start, self.code.display.start)
        };
        let point =
            |source: SourcePoint| DisplayOffset(display_start + source.source.0 - source_start);
        let resulting = DisplayRange {
            start: point(exact.start),
            end: point(exact.end),
        };
        if self.engine.selection != resulting || self.engine.affinity != affinity {
            self.engine.typing = None;
            self.engine.pending_formats = None;
        }
        self.engine.selection = resulting;
        self.engine.affinity = affinity;
        self.history_selection = SourceSelection::Exact(exact);
        self.generation = generation;
        if let Some(mut changed) = frame {
            changed.selection = resulting;
            changed.affinity = affinity;
            changed.work.metadata_items += work.metadata_items;
            Ok(BoundedProgress::Change(changed))
        } else {
            Ok(BoundedProgress::Status(BoundedProgressStatus {
                previous: cursor,
                cursor: self.cursor(),
                selection: resulting,
                affinity,
                continuation: self.continuation(),
                work: *work,
            }))
        }
    }
}
