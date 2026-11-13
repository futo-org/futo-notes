//! Find in the note, over the display text: hidden markers and syntax are
//! never found, and every line break is a barrier (there are no paragraphs).
//! In a table only cell contents are found: pipes, padding and the
//! delimiter row are barriers. Front matter and dividers are never found.
//!
//! Scanning is explicit, never on the input path. Each accepted change only
//! logs its display window (`Engine::accept` calls `Find::edited`); matches
//! are carried through that log on the next find read, those inside a
//! replaced window are dropped, and the report is `stale` until a rescan
//! lands. Find never edits the note, so it adds no undo step.
use super::super::line::Role;
use super::super::Engine;
use crate::lines::{table, Kind, TableRole};
use crate::{
    CaretDirection, DisplayOffset, DisplayRange, EditorError, FindReport, FindScanRequest,
    FindScanResult, FindWork, Revision, SourceOffset, SourceRange,
};
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};

/// Unread edits kept before the matches are dropped until a rescan.
const LOG_LIMIT: usize = 64;

/// Names each engine for scan results; never reused within a process.
static NEXT_INCARNATION: AtomicU64 = AtomicU64::new(1);

/// The find state of one note: the query, the matches and the current one.
pub(crate) struct Find {
    incarnation: u64,
    open: bool,
    query: String,
    generation: u64,
    matches: Vec<DisplayRange>,
    current: Option<usize>,
    /// Times an edit dropped the current match (`FindReport::dropped`).
    dropped: u64,
    /// Where stepping without a current match starts, in display offsets.
    anchor: usize,
    /// The current match while an overflowed log has cleared the matches.
    lost: Option<DisplayRange>,
    /// Display windows replaced since the last read, with their new lengths.
    log: Vec<(DisplayRange, usize)>,
    /// The log overflowed: the matches are gone until a rescan.
    invalid: bool,
    /// Input since the last scan.
    dirty: bool,
    /// The revision the matches and the log describe.
    revision: Revision,
    work: FindWork,
    barrier_bytes: Cell<u64>,
}

impl Find {
    pub(crate) fn new() -> Self {
        Self {
            incarnation: NEXT_INCARNATION.fetch_add(1, Ordering::Relaxed),
            open: false,
            query: String::new(),
            generation: 0,
            matches: Vec::new(),
            current: None,
            dropped: 0,
            anchor: 0,
            lost: None,
            log: Vec::new(),
            invalid: false,
            dirty: false,
            revision: Revision(0),
            work: FindWork::default(),
            barrier_bytes: Cell::new(0),
        }
    }

    /// O(1): log that display `range` was replaced by `inserted` bytes,
    /// making `revision`.
    pub(crate) fn edited(
        &mut self,
        range: std::ops::Range<usize>,
        inserted: usize,
        revision: Revision,
    ) {
        if !self.open {
            return;
        }
        self.revision = revision;
        self.dirty = true;
        let window = DisplayRange {
            start: DisplayOffset(range.start),
            end: DisplayOffset(range.end),
        };
        if self.invalid {
            self.track(window, inserted);
        } else if self.log.len() >= LOG_LIMIT {
            self.log.push((window, inserted));
            self.invalid = true;
            // The matches go, but the current one and the step position are
            // still carried: a drop counts only if an edit touched it.
            self.lost = self.current.take().map(|at| self.matches[at]);
            for (window, inserted) in std::mem::take(&mut self.log) {
                self.track(window, inserted);
            }
            self.matches.clear();
        } else {
            self.log.push((window, inserted));
        }
    }

    /// Carry the lost current match and the step position through one edit.
    fn track(&mut self, window: DisplayRange, inserted: usize) {
        let (start, end) = (window.start.0, window.end.0);
        if let Some(found) = &mut self.lost {
            if found.end.0 > start && found.start.0 < end {
                self.dropped += 1;
                self.lost = None;
            } else if found.start.0 >= end {
                found.start.0 = found.start.0 - (end - start) + inserted;
                found.end.0 = found.end.0 - (end - start) + inserted;
            }
        }
        self.anchor = moved(self.anchor, start, end, inserted);
    }

    /// Carry the matches through the logged edits.
    fn rebase(&mut self) {
        for (window, inserted) in std::mem::take(&mut self.log) {
            let (start, end) = (window.start.0, window.end.0);
            let first = self.matches.partition_point(|found| found.end.0 <= start);
            let after = self
                .matches
                .partition_point(|found| found.start.0 < end)
                .max(first);
            self.matches.drain(first..after);
            for found in &mut self.matches[first..] {
                found.start.0 = found.start.0 - (end - start) + inserted;
                found.end.0 = found.end.0 - (end - start) + inserted;
            }
            let removed = after - first;
            self.current = match self.current {
                Some(at) if at >= after => Some(at - removed),
                Some(at) if at >= first => {
                    self.dropped += 1;
                    None
                }
                other => other,
            };
            self.anchor = moved(self.anchor, start, end, inserted);
        }
    }

    /// Clear the matches and pending scans; the query stays.
    fn reset(&mut self, revision: Revision) {
        self.generation += 1;
        self.matches.clear();
        self.current = None;
        self.log.clear();
        self.invalid = false;
        self.dirty = false;
        self.revision = revision;
    }

    /// The first match at or after the step position, wrapping.
    fn choose(&self) -> Option<usize> {
        let at = self
            .matches
            .partition_point(|found| found.start.0 < self.anchor);
        (!self.matches.is_empty()).then(|| at % self.matches.len())
    }
}

/// Where a display position goes when `start..end` becomes `inserted` bytes.
fn moved(at: usize, start: usize, end: usize, inserted: usize) -> usize {
    if at >= end {
        at - (end - start) + inserted
    } else if at > start {
        start
    } else {
        at
    }
}

impl Engine {
    /// Bring the matches up to date with the edits since the last read. A
    /// change that reached the note without being logged drops them.
    fn find_rebase(&mut self) {
        let find = &mut self.find;
        if find.open && find.revision != self.revision {
            if find.current.take().is_some() {
                find.dropped += 1;
            }
            find.lost = None;
            find.matches.clear();
            find.log.clear();
            find.invalid = true;
            find.dirty = true;
            find.revision = self.revision;
        }
        find.rebase();
    }

    /// Open find, or change its query, and scan now. The current match is
    /// the first at or after the selection start, wrapping to the first.
    pub(crate) fn find_set_query(
        &mut self,
        expected: Revision,
        query: &str,
    ) -> Result<FindReport, EditorError> {
        self.check_revision(expected)?;
        self.find.open = true;
        self.find.query = query.to_owned();
        self.find.reset(self.revision);
        self.find.anchor = self.selection.start.0;
        if let Some(request) = self.find_scan_request() {
            self.find_apply_scan(&request.run());
        }
        let reveal = self.find.current.map(|at| self.find.matches[at]);
        Ok(self.find_report_with(reveal))
    }

    /// Step to the next or previous match, wrapping, and select it. A no-op
    /// while closed, at zero matches or during composition.
    pub(crate) fn find_step(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<FindReport, EditorError> {
        self.check_revision(expected)?;
        self.find_rebase();
        let total = self.find.matches.len();
        if !self.find.open || total == 0 || self.composition.is_some() {
            return Ok(self.find_report_with(None));
        }
        let matches = &self.find.matches;
        let anchor = self.find.anchor;
        let at = match (self.find.current, direction) {
            (Some(at), CaretDirection::Forward) => (at + 1) % total,
            (Some(at), CaretDirection::Backward) => (at + total - 1) % total,
            (None, CaretDirection::Forward) => {
                matches.partition_point(|found| found.start.0 < anchor) % total
            }
            (None, CaretDirection::Backward) => {
                (matches.partition_point(|found| found.end.0 <= anchor) + total - 1) % total
            }
        };
        let range = matches[at];
        self.select(expected, range)?;
        self.find.current = Some(at);
        self.find.anchor = range.start.0;
        Ok(self.find_report_with(Some(range)))
    }

    /// Close find: the matches go and in-flight scans are refused; the
    /// query is kept for the next open, and the selection stays.
    pub(crate) fn find_close(&mut self) -> FindReport {
        self.find.open = false;
        self.find.reset(self.revision);
        self.find_report_with(None)
    }

    pub(crate) fn find_report(&mut self) -> FindReport {
        self.find_rebase();
        self.find_report_with(None)
    }

    /// The matches overlapping display `range`, for highlighting a window.
    pub(crate) fn find_matches(
        &mut self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Vec<DisplayRange>, EditorError> {
        self.check_revision(expected)?;
        self.check_display_range(range)?;
        self.find_rebase();
        let matches = &self.find.matches;
        let first = matches.partition_point(|found| found.end.0 <= range.start.0);
        let after = matches
            .partition_point(|found| found.start.0 < range.end.0)
            .max(first);
        Ok(matches[first..after].to_vec())
    }

    /// A snapshot to scan off the input path: the whole display and the
    /// table barriers in it. Hosts take it after input settles.
    pub(crate) fn find_scan_request(&self) -> Option<FindScanRequest> {
        if !self.find.open || self.find.query.is_empty() {
            return None;
        }
        let mut text = String::with_capacity(self.display_len());
        let mut barriers = Vec::new();
        let mut read = 0;
        for entry in self.store.iter_from(0) {
            let base = text.len();
            text.push_str(&entry.display());
            let mut barrier = |start: usize, end: usize| {
                if start < end {
                    barriers.push(DisplayRange {
                        start: DisplayOffset(base + start),
                        end: DisplayOffset(base + end),
                    });
                }
            };
            // Front matter is metadata no selection lands in, and a divider
            // shows an object replacement character, not text.
            if matches!(entry.line.kind, Kind::FrontMatter(_) | Kind::Divider) {
                barrier(0, entry.size.display);
                continue;
            }
            let Kind::Table { role, .. } = &entry.line.kind else {
                continue;
            };
            if entry.view.role != Role::Text {
                continue;
            }
            read += entry.text.len();
            let shown = entry.shown_len();
            if *role == TableRole::Delimiter {
                barrier(0, shown);
                continue;
            }
            let body = entry.body();
            let mut at = 0;
            for cell in table::cells(body) {
                let content = table::trimmed(body, &cell);
                let start = entry.to_display(content.start);
                barrier(at, start);
                at = entry.to_display(content.end).max(start);
            }
            barrier(at, shown);
        }
        self.find
            .barrier_bytes
            .set(self.find.barrier_bytes.get() + read as u64);
        Some(FindScanRequest {
            incarnation: self.find.incarnation,
            generation: self.find.generation,
            revision: self.revision,
            query: self.find.query.clone(),
            text,
            soft_breaks: Vec::new(),
            barriers,
        })
    }

    /// Take a scan's matches, only for this engine and the exact revision
    /// and query they were taken at; anything else is refused with no state
    /// change. Matches must be non-empty, ascending, non-overlapping and on
    /// character boundaries of the display.
    pub(crate) fn find_apply_scan(&mut self, result: &FindScanResult) -> Option<FindReport> {
        if !self.find.open
            || result.incarnation != self.find.incarnation
            || result.generation != self.find.generation
            || result.revision != self.revision
        {
            return None;
        }
        let mut previous = 0;
        for found in &result.matches {
            let (start, end) = (found.start.0, found.end.0);
            if start < previous
                || end <= start
                || self.check_display(start).is_err()
                || self.check_display(end).is_err()
            {
                return None;
            }
            previous = end;
        }
        self.find_rebase();
        let find = &mut self.find;
        find.matches = result.matches.clone();
        find.log.clear();
        find.invalid = false;
        find.dirty = false;
        find.work.scans += 1;
        find.work.scanned_bytes += result.scanned_bytes;
        find.current = find.choose();
        if let Some(at) = find.current {
            find.anchor = find.matches[at].start.0;
        }
        Some(self.find_report_with(None))
    }

    pub(crate) fn find_work(&self) -> FindWork {
        FindWork {
            barrier_bytes: self.find.barrier_bytes.get(),
            ..self.find.work
        }
    }

    fn find_report_with(&self, reveal: Option<DisplayRange>) -> FindReport {
        let find = &self.find;
        let current_range = find.current.map(|at| find.matches[at]);
        FindReport {
            revision: self.revision,
            open: find.open,
            query: find.query.clone(),
            total: find.matches.len(),
            current: find.current.map_or(0, |at| at + 1),
            current_range,
            current_source: current_range.map(|range| {
                let start = self.source_bounds(range.start.0).1;
                let end = self.source_bounds(range.end.0).0.max(start);
                SourceRange {
                    start: SourceOffset(start),
                    end: SourceOffset(end),
                }
            }),
            reveal,
            stale: find.open && !find.query.is_empty() && find.dirty,
            dropped: find.dropped,
        }
    }
}
