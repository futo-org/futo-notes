//! The editor core. The note's text is the only stored text: it is kept as
//! lines, each with its reading, and the display is computed from each line's
//! text and reading (`line.rs` states the few display rules that are not
//! "text minus hidden pieces"). After an edit the changed lines are read
//! again until the reader's carry settles. A position converts by finding its
//! line through the per-line size index, then stepping over the line's
//! hidden pieces.
//!
//! Only `EditorSession` under the `engine` feature (never in a shipping
//! build) calls this module until the surface moves onto it.
#![allow(dead_code)]

mod command;
mod commands;
mod edit;
mod history;
mod line;
mod project;
mod read;
mod selection;
mod store;
mod surface;
#[cfg(test)]
mod tests;
mod utf16;

pub(crate) use edit::Marked;

use crate::history::{HistoryClock, MonotonicClock, TypingRun};
use crate::{
    Affinity, DisplayOffset, DisplayRange, EditorError, InlineFormat, Revision, SourceOffset,
};
use history::History;
use line::{Entry, Role};
use std::sync::Arc;
use store::{Size, Store};

pub(crate) struct Engine {
    store: Store,
    revision: Revision,
    selection: DisplayRange,
    affinity: Affinity,
    /// Formats typing at a collapsed caret carries; set by format toggles.
    formats: Option<Vec<InlineFormat>>,
    /// The collapsed caret's exact source offset after an edit, kept while
    /// the selection stays where the edit left it.
    pin: Option<usize>,
    history: History,
    clock: Arc<dyn HistoryClock>,
    typing: Option<TypingRun>,
    composition: Option<Marked>,
    /// Find's query and matches (`commands/find.rs`).
    find: commands::find::Find,
    /// The vault's note ids, which wikilinks resolve against. The host
    /// delivers them; they are not text, history or saved state.
    notes: Arc<futo_notes_wikilinks::WikilinkIndex>,
}

impl Engine {
    pub fn open(text: &str) -> Self {
        Self::open_with_clock(text, Arc::new(MonotonicClock::default()))
    }

    pub fn open_with_clock(text: &str, clock: Arc<dyn HistoryClock>) -> Self {
        Self::restore_with_clock(text, Revision(0), clock)
    }

    /// Open `text` at `revision`, with no history.
    pub fn restore_with_clock(
        text: &str,
        revision: Revision,
        clock: Arc<dyn HistoryClock>,
    ) -> Self {
        let mut engine = Self {
            store: read::open(text),
            revision,
            selection: DisplayRange::default(),
            affinity: Affinity::Forward,
            formats: None,
            pin: None,
            history: History::default(),
            clock,
            typing: None,
            composition: None,
            find: commands::find::Find::new(),
            notes: Arc::default(),
        };
        let body = DisplayOffset(engine.metadata_end().unwrap_or(0));
        engine.selection = DisplayRange {
            start: body,
            end: body,
        };
        engine
    }

    pub fn revision(&self) -> Revision {
        self.revision
    }

    pub fn selection(&self) -> DisplayRange {
        self.selection
    }

    pub fn affinity(&self) -> Affinity {
        self.affinity
    }

    /// Explicit whole-text query; never called by the input path.
    pub fn source_text(&self) -> String {
        self.store
            .iter_from(0)
            .map(|entry| entry.text.as_str())
            .collect()
    }

    /// Explicit whole-display query; never called by the input path.
    pub fn display_text(&self) -> String {
        self.store.iter_from(0).map(Entry::display).collect()
    }

    pub fn source_len(&self) -> usize {
        self.store.total().source
    }

    pub fn display_len(&self) -> usize {
        self.store.total().display
    }

    pub(crate) fn check_revision(&self, expected: Revision) -> Result<(), EditorError> {
        if expected == self.revision {
            Ok(())
        } else {
            Err(EditorError::StaleRevision {
                expected,
                actual: self.revision,
            })
        }
    }

    // ---- Lines and positions ----

    /// The line holding display offset `at`: the first line whose display
    /// reaches past it, or at the display's end the last line that shows.
    fn line_at_display(&self, measure: store::Measure, at: usize) -> (usize, Size) {
        self.store.line_past(measure, at).unwrap_or_else(|| {
            let mut index = self.store.len() - 1;
            while index > 0 && self.store.get(index).view.role == Role::Hidden {
                index -= 1;
            }
            (index, self.store.before(index))
        })
    }

    /// Display offset `at` checked to be a character boundary of the display.
    fn check_display(&self, at: usize) -> Result<(usize, Size), EditorError> {
        if at > self.display_len() {
            return Err(EditorError::InvalidRange);
        }
        let (index, before) = self.line_at_display(store::display, at);
        let shown = self.store.get(index).display();
        if !shown.is_char_boundary(at - before.display) {
            return Err(EditorError::InvalidRange);
        }
        Ok((index, before))
    }

    fn check_display_range(&self, range: DisplayRange) -> Result<(), EditorError> {
        if range.start.0 > range.end.0 {
            return Err(EditorError::InvalidRange);
        }
        self.check_display(range.start.0)?;
        self.check_display(range.end.0)?;
        Ok(())
    }

    /// The source offsets a caret at display offset `at` may stand at, lowest
    /// and highest: `Backward` takes the lowest, `Forward` the highest.
    pub(crate) fn source_bounds(&self, at: usize) -> (usize, usize) {
        let (index, before) = self.line_at_display(store::display, at);
        let (lo, hi) = self
            .store
            .get(index)
            .sources(at - before.display, true)
            .expect("a display offset inside its line");
        (before.source + lo, before.source + hi)
    }

    /// Every source offset that shows at display offset `at`, ignoring
    /// where a caret may stand.
    fn source_span(&self, at: usize) -> (usize, usize) {
        let (index, before) = self.line_at_display(store::display, at);
        let (lo, hi) = self
            .store
            .get(index)
            .sources(at - before.display, false)
            .expect("a display offset inside its line");
        (before.source + lo, before.source + hi)
    }

    /// The display offset source offset `at` shows at.
    pub(crate) fn display_of(&self, at: usize) -> usize {
        let (index, before) = read::line_at(&self.store, at);
        before.display + self.store.get(index).to_display(at - before.source)
    }

    pub fn source_at(
        &self,
        expected: Revision,
        offset: DisplayOffset,
        affinity: Affinity,
    ) -> Result<SourceOffset, EditorError> {
        self.check_revision(expected)?;
        self.check_display(offset.0)?;
        let (lo, hi) = self.source_bounds(offset.0);
        Ok(SourceOffset(match affinity {
            Affinity::Backward => lo,
            Affinity::Forward => hi,
        }))
    }

    pub fn display_at(
        &self,
        expected: Revision,
        offset: SourceOffset,
    ) -> Result<DisplayOffset, EditorError> {
        self.check_revision(expected)?;
        self.check_source(offset.0)?;
        Ok(DisplayOffset(self.display_of(offset.0)))
    }

    fn check_source(&self, at: usize) -> Result<(), EditorError> {
        if at > self.source_len() {
            return Err(EditorError::InvalidRange);
        }
        let (index, before) = read::line_at(&self.store, at);
        if self
            .store
            .get(index)
            .text
            .is_char_boundary(at - before.source)
        {
            Ok(())
        } else {
            Err(EditorError::InvalidRange)
        }
    }

    /// Where the collapsed caret maps in the source: its pin, else the side
    /// its affinity picks.
    pub(crate) fn caret_source(&self) -> usize {
        if let Some(pin) = self.pin {
            return pin;
        }
        let (lo, hi) = self.source_bounds(self.selection.start.0);
        match self.affinity {
            Affinity::Backward => lo,
            Affinity::Forward => hi,
        }
    }

    /// The display text in `range` (checked by the caller).
    pub(crate) fn display_slice(&self, range: std::ops::Range<usize>) -> String {
        let (index, before) = self.line_at_display(store::display, range.start);
        let mut out = String::new();
        let mut at = before.display;
        for entry in self.store.iter_from(index) {
            if at >= range.end {
                break;
            }
            let shown = entry.display();
            let from = range.start.saturating_sub(at).min(shown.len());
            let to = (range.end - at).min(shown.len());
            out.push_str(&shown[from..to]);
            at += shown.len();
        }
        out
    }

    /// The source text in `range` (checked by the caller).
    pub(crate) fn source_slice(&self, range: std::ops::Range<usize>) -> String {
        let (index, before) = read::line_at(&self.store, range.start);
        let mut out = String::new();
        let mut at = before.source;
        for entry in self.store.iter_from(index) {
            if at >= range.end {
                break;
            }
            let text = &entry.text;
            let from = range.start.saturating_sub(at).min(text.len());
            let to = (range.end - at).min(text.len());
            out.push_str(&text[from..to]);
            at += text.len();
        }
        out
    }

    // ---- Front matter ----

    /// The display offset where the body starts after front matter, which
    /// is inert metadata: no caret rests in it and no edit touches part of it.
    pub(crate) fn metadata_end(&self) -> Option<usize> {
        use crate::lines::{FrontMatterRole, Kind};
        if self.store.get(0).line.kind != Kind::FrontMatter(FrontMatterRole::Open) {
            return None;
        }
        let close = self
            .store
            .iter_from(0)
            .position(|entry| entry.line.kind == Kind::FrontMatter(FrontMatterRole::Close))?;
        Some(if self.store.get(close).view.role == Role::Empty {
            self.store.before(close).display
        } else {
            self.store.before(close + 1).display
        })
    }

    /// A selection with no end resting in metadata, unless it covers it all.
    fn outside_metadata(&self, range: DisplayRange) -> DisplayRange {
        let Some(body) = self.metadata_end() else {
            return range;
        };
        if range.start.0 == 0 && range.end.0 >= body && body > 0 {
            return range;
        }
        let snap = |at: DisplayOffset| DisplayOffset(at.0.max(body));
        DisplayRange {
            start: snap(range.start),
            end: snap(range.end),
        }
    }

    /// Whether an edit of display `range` would change part of the metadata.
    fn touches_metadata(&self, range: DisplayRange) -> bool {
        self.metadata_end().is_some_and(|body| {
            range.start.0 < body && !(range.start.0 == 0 && range.end.0 >= body)
        })
    }
}
