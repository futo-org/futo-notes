//! Note-local find over visible display text. Matching is a pure scan of a
//! snapshot, run explicitly (never from the input path). Input only logs the
//! edit's display window; matches are rebased from that log on the next read, and
//! windows that cannot be mapped drop their matches until a fresh scan lands.
//! Find never edits source, so it adds no undo action or recovery record.
use super::*;
use crate::CaretDirection;
use serde::{Deserialize, Serialize};

const REBASE_LOG_LIMIT: usize = 64;

/// Explicit scan accounting: ordinary input never moves these.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FindWork {
    pub scans: u64,
    pub scanned_bytes: u64,
    /// Source bytes the table-barrier pass materialized for scan requests.
    pub barrier_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindReport {
    pub revision: Revision,
    pub open: bool,
    /// The active query, or the remembered one while closed.
    pub query: String,
    pub total: usize,
    /// One-based position of the current match; zero when there is none.
    pub current: usize,
    pub current_range: Option<DisplayRange>,
    /// Tight source bytes of the current match, for selection or reveal.
    pub current_source: Option<SourceRange>,
    /// Set only when this call moved the current match: scroll it into view.
    pub reveal: Option<DisplayRange>,
    /// Input arrived since the last scan: totals may lag until a scan applies.
    pub stale: bool,
    /// How often an edit has dropped the current match (a later scan then chooses another).
    /// A host compares it across presses to see the current match change without one. Not
    /// serialized: it is a host-side signal, not part of the portable payload.
    #[serde(skip)]
    pub dropped: u64,
}

/// Owned snapshot a host may scan on any thread. A result is accepted only for
/// the same session, revision and query generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindScanRequest {
    /// The session that took the snapshot; another session's result is stale.
    pub incarnation: u64,
    pub generation: u64,
    pub revision: Revision,
    pub query: String,
    pub text: String,
    pub soft_breaks: Vec<DisplayRange>,
    /// Table text outside cell contents: pipes, padding, delimiter rows and
    /// row breaks. A match never touches or spans these.
    #[serde(default)]
    pub barriers: Vec<DisplayRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindScanResult {
    pub incarnation: u64,
    pub generation: u64,
    pub revision: Revision,
    pub matches: Vec<DisplayRange>,
    pub scanned_bytes: u64,
}

#[derive(Default)]
pub(crate) struct FindState {
    open: bool,
    query: String,
    generation: u64,
    matches: Vec<DisplayRange>,
    current: Option<usize>,
    /// Times an edit dropped the current match, for `FindReport::dropped`.
    dropped: u64,
    anchor: usize,
    log: Vec<(DisplayRange, usize)>,
    invalid: bool,
    /// Input since the last scan; cleared only by a scan or close.
    dirty: bool,
    work: FindWork,
    barrier_bytes: std::cell::Cell<u64>,
}

impl FindState {
    /// O(1): record the replaced old-display window and its new length.
    pub(crate) fn edited(&mut self, range: DisplayRange, inserted: usize) {
        if !self.open {
            return;
        }
        self.dirty = true;
        if self.invalid {
            return;
        }
        if self.log.len() >= REBASE_LOG_LIMIT {
            self.invalid = true;
            self.matches.clear();
            self.dropped += u64::from(self.current.take().is_some());
            self.log.clear();
        } else {
            self.log.push((range, inserted));
        }
    }

    fn rebase(&mut self) {
        for (range, inserted) in std::mem::take(&mut self.log) {
            let (start, end) = (range.start.0, range.end.0);
            let first = self.matches.partition_point(|found| found.end.0 <= start);
            let after = self.matches.partition_point(|found| found.start.0 < end);
            let after = after.max(first);
            let removed = after - first;
            self.matches.drain(first..after);
            for found in &mut self.matches[first..] {
                found.start.0 = found.start.0 - (end - start) + inserted;
                found.end.0 = found.end.0 - (end - start) + inserted;
            }
            self.current = match self.current {
                Some(at) if at >= after => Some(at - removed),
                Some(at) if at >= first => {
                    self.dropped += 1;
                    None
                }
                other => other,
            };
            if self.anchor >= end {
                self.anchor = self.anchor - (end - start) + inserted;
            } else if self.anchor > start {
                self.anchor = start;
            }
        }
    }

    fn stale(&self) -> bool {
        self.open && !self.query.is_empty() && self.dirty
    }

    fn choose(&self) -> Option<usize> {
        let at = self
            .matches
            .partition_point(|found| found.start.0 < self.anchor);
        (!self.matches.is_empty()).then(|| at % self.matches.len())
    }
}

/// Locale-independent letter folding; every Greek sigma is one letter and a
/// character whose lowercase is longer matches only itself, so folding never
/// moves a match off the text it covers.
fn fold(character: char) -> char {
    let mut lower = character.to_lowercase();
    let first = lower.next().unwrap_or(character);
    let folded = if lower.next().is_none() {
        first
    } else {
        character
    };
    if folded == 'ς' {
        'σ'
    } else {
        folded
    }
}

impl FindScanRequest {
    /// Literal case-insensitive occurrences, ascending and non-overlapping. A
    /// paragraph's line break reads as one space; any other break and table text
    /// outside cell contents is a barrier.
    pub fn run(&self) -> FindScanResult {
        let mut result = FindScanResult {
            incarnation: self.incarnation,
            generation: self.generation,
            revision: self.revision,
            matches: Vec::new(),
            scanned_bytes: self.text.len() as u64,
        };
        let needle: Vec<char> = self.query.chars().map(fold).collect();
        if needle.is_empty() || self.query.contains(['\r', '\n']) {
            return result;
        }
        let mut haystack = Vec::new();
        let mut starts = Vec::new();
        let mut soft = self.soft_breaks.iter().peekable();
        let mut barriers = self.barriers.iter().peekable();
        let mut skip = 0;
        for (at, character) in self.text.char_indices() {
            if at < skip {
                continue;
            }
            while soft.next_if(|range| range.end.0 <= at).is_some() {}
            while barriers.next_if(|range| range.end.0 <= at).is_some() {}
            starts.push(at);
            if barriers.peek().is_some_and(|range| range.start.0 <= at) {
                haystack.push('\n');
            } else if let Some(range) = soft.next_if(|range| range.start.0 == at) {
                skip = range.end.0;
                haystack.push(' ');
            } else if matches!(character, '\r' | '\n') {
                haystack.push('\n');
            } else {
                haystack.push(fold(character));
            }
        }
        starts.push(self.text.len());
        let mut at = 0;
        while at + needle.len() <= haystack.len() {
            if haystack[at..at + needle.len()] == needle[..] {
                result.matches.push(DisplayRange {
                    start: DisplayOffset(starts[at]),
                    end: DisplayOffset(starts[at + needle.len()]),
                });
                at += needle.len();
            } else {
                at += 1;
            }
        }
        result
    }
}

impl EditorSession {
    /// Open find, or change its query, and scan now. This is an explicit find
    /// action; typing in the note never scans. The current match is the first
    /// at or after the selection start, wrapping to the first.
    pub fn find_set_query(
        &mut self,
        expected: Revision,
        query: &str,
    ) -> Result<FindReport, EditorError> {
        self.check_revision(expected)?;
        self.find.open = true;
        self.find.query = query.to_owned();
        self.find.generation += 1;
        self.find.matches.clear();
        self.find.current = None;
        self.find.log.clear();
        self.find.invalid = false;
        self.find.dirty = false;
        self.find.anchor = self.selection.start.0;
        if let Some(request) = self.find_scan_request() {
            self.find_apply_scan(&request.run());
        }
        let reveal = self.find.current.map(|at| self.find.matches[at]);
        Ok(self.find_report_with(reveal))
    }

    /// Step to the next or previous match, wrapping, and select it. A no-op
    /// while closed, at zero matches or during composition, like `select`:
    /// the current match and selection stay together.
    pub fn find_step(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<FindReport, EditorError> {
        self.check_revision(expected)?;
        self.find.rebase();
        let total = self.find.matches.len();
        if !self.find.open || total == 0 || self.composition.is_some() {
            return Ok(self.find_report_with(None));
        }
        let forward = direction == CaretDirection::Forward;
        let at = match (self.find.current, forward) {
            (Some(at), true) => (at + 1) % total,
            (Some(at), false) => (at + total - 1) % total,
            (None, true) => {
                let after = self
                    .find
                    .matches
                    .partition_point(|found| found.start.0 < self.find.anchor);
                after % total
            }
            (None, false) => {
                let before = self
                    .find
                    .matches
                    .partition_point(|found| found.end.0 <= self.find.anchor);
                (before + total - 1) % total
            }
        };
        let range = self.find.matches[at];
        self.select(expected, range)?;
        self.find.current = Some(at);
        self.find.anchor = range.start.0;
        Ok(self.find_report_with(Some(range)))
    }

    /// Clear matches and invalidate in-flight scans; the query is remembered
    /// for the next open of this note. The selection is left where it is.
    pub fn find_close(&mut self) -> FindReport {
        self.find.open = false;
        self.find.generation += 1;
        self.find.matches.clear();
        self.find.current = None;
        self.find.log.clear();
        self.find.invalid = false;
        self.find.dirty = false;
        self.find_report_with(None)
    }

    pub fn find_report(&mut self) -> FindReport {
        self.find.rebase();
        self.find_report_with(None)
    }

    /// Matches overlapping `range`, for highlighting a window.
    pub fn find_matches(
        &mut self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Vec<DisplayRange>, EditorError> {
        self.check_revision(expected)?;
        self.validate_range(range)?;
        self.find.rebase();
        let first = self
            .find
            .matches
            .partition_point(|found| found.end.0 <= range.start.0);
        let after = self
            .find
            .matches
            .partition_point(|found| found.start.0 < range.end.0);
        Ok(self.find.matches[first..after.max(first)].to_vec())
    }

    /// Snapshot for an off-path rescan. Whole-text materialization, so hosts
    /// call it after input settles, never per keystroke.
    pub fn find_scan_request(&self) -> Option<FindScanRequest> {
        (self.find.open && !self.find.query.is_empty()).then(|| FindScanRequest {
            incarnation: self.incarnation,
            generation: self.find.generation,
            revision: self.revision,
            query: self.find.query.clone(),
            text: self.display_text(),
            soft_breaks: self.projection.soft_line_breaks(),
            barriers: self.table_find_barriers(&self.find.barrier_bytes),
        })
    }

    /// Accept a scan only for this session, and the exact revision and query it was taken at;
    /// anything else is rejected as stale with no state change. Host-supplied matches must
    /// also be non-empty, ascending, non-overlapping, in range and on character boundaries.
    pub fn find_apply_scan(&mut self, result: &FindScanResult) -> Option<FindReport> {
        if !self.find.open
            || result.incarnation != self.incarnation
            || result.generation != self.find.generation
            || result.revision != self.revision
        {
            return None;
        }
        let display = &self.projection.display;
        let boundary = |at: usize| {
            at <= display.len_bytes() && display.char_to_byte(display.byte_to_char(at)) == at
        };
        let mut previous = 0;
        for found in &result.matches {
            let (start, end) = (found.start.0, found.end.0);
            if start < previous || end <= start || !boundary(start) || !boundary(end) {
                return None;
            }
            previous = end;
        }
        self.find.rebase();
        self.find.matches = result.matches.clone();
        self.find.log.clear();
        self.find.invalid = false;
        self.find.dirty = false;
        self.find.work.scans += 1;
        self.find.work.scanned_bytes += result.scanned_bytes;
        self.find.current = self.find.choose();
        if let Some(at) = self.find.current {
            self.find.anchor = self.find.matches[at].start.0;
        }
        Some(self.find_report_with(None))
    }

    pub fn find_work(&self) -> FindWork {
        FindWork {
            barrier_bytes: self.find.barrier_bytes.get(),
            ..self.find.work
        }
    }

    fn find_report_with(&self, reveal: Option<DisplayRange>) -> FindReport {
        let current_range = self.find.current.map(|at| self.find.matches[at]);
        FindReport {
            revision: self.revision,
            open: self.find.open,
            query: self.find.query.clone(),
            total: self.find.matches.len(),
            current: self.find.current.map_or(0, |at| at + 1),
            current_range,
            current_source: current_range.map(|range| {
                let start = self.projection.source_bounds(range.start.0).1;
                let end = self.projection.source_bounds(range.end.0).0;
                SourceRange {
                    start: SourceOffset(start),
                    end: SourceOffset(end.max(start)),
                }
            }),
            reveal,
            stale: self.find.stale(),
            dropped: self.find.dropped,
        }
    }
}
