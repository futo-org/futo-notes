//! Note-local find over visible display text (`crate::engine::commands::find`
//! does the work). Matching is a pure scan of a snapshot, run explicitly, never
//! from the input path. Find never edits source, so it adds no undo action or
//! recovery record.
use super::EditorSession;
use crate::{CaretDirection, DisplayOffset, DisplayRange, EditorError, Revision, SourceRange};
use serde::{Deserialize, Serialize};

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
        self.run(|e| e.find_set_query(expected, query))
    }

    /// Step to the next or previous match, wrapping, and select it. A no-op
    /// while closed, at zero matches or during composition, like `select`:
    /// the current match and selection stay together.
    pub fn find_step(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<FindReport, EditorError> {
        self.run(|e| e.find_step(expected, direction))
    }

    /// Clear matches and invalidate in-flight scans; the query is remembered
    /// for the next open of this note. The selection is left where it is.
    pub fn find_close(&mut self) -> FindReport {
        self.run(|e| e.find_close())
    }

    pub fn find_report(&mut self) -> FindReport {
        self.run(|e| e.find_report())
    }

    /// Matches overlapping `range`, for highlighting a window.
    pub fn find_matches(
        &mut self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Vec<DisplayRange>, EditorError> {
        self.run(|e| e.find_matches(expected, range))
    }

    /// Snapshot for an off-path rescan. Whole-text materialization, so hosts
    /// call it after input settles, never per keystroke.
    pub fn find_scan_request(&self) -> Option<FindScanRequest> {
        self.engine.find_scan_request()
    }

    /// Accept a scan only for this session, and the exact revision and query it was taken at;
    /// anything else is rejected as stale with no state change. Host-supplied matches must
    /// also be non-empty, ascending, non-overlapping, in range and on character boundaries.
    pub fn find_apply_scan(&mut self, result: &FindScanResult) -> Option<FindReport> {
        self.run(|e| e.find_apply_scan(result))
    }

    pub fn find_work(&self) -> FindWork {
        self.engine.find_work()
    }
}
