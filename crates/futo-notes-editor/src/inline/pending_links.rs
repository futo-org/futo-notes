//! Unfinished typed URLs are row-local transient meaning. Exact source remains
//! bare; reopening interprets it normally. History snapshots only touched rows.
use super::{
    row::{Row, Span, SpanKind},
    Projection,
};
use crate::{DisplayOffset, DisplayRange, SourceEdit, SourceRange};
use std::ops::Range;

#[derive(Clone)]
pub(crate) struct PendingLinks {
    pub window: Range<usize>,
    pub ranges: Vec<Range<usize>>,
    pub delimiters: Vec<Range<usize>>,
    pub work: usize,
}
impl PendingLinks {
    /// Translate exact source windows, including every transient witness.
    pub(crate) fn relocate_source(&mut self, origin: usize) -> usize {
        self.window.start += origin;
        self.window.end += origin;
        for range in self.ranges.iter_mut().chain(&mut self.delimiters) {
            range.start += origin;
            range.end += origin;
        }
        2 * (1 + self.ranges.len() + self.delimiters.len())
    }

    pub fn after_window(&self, edit: &SourceEdit) -> Range<usize> {
        self.window.start..self.window.end - edit.removed.len() + edit.inserted.len()
    }
}

impl Projection {
    pub(crate) fn pending_for_source_edit(&self, edit: SourceRange) -> PendingLinks {
        let first = self.rows.locate(edit.start.0, false).saturating_sub(1);
        let last = (self.rows.locate(edit.end.0, false) + 1).min(self.rows.len() - 1);
        let (_, start, _) = self.rows.at(first);
        let (row, end, _) = self.rows.at(last);
        self.pending_links(start..end + row.source_len)
    }

    /// Source-coordinate snapshot for one original source window. Staging must
    /// relocate these source positions only when its raw window is exact.
    pub(crate) fn pending_links(&self, window: Range<usize>) -> PendingLinks {
        let first = self.rows.locate(window.start, false);
        let last = self.rows.locate(
            window
                .end
                .saturating_sub(usize::from(window.end > window.start)),
            false,
        );
        let mut ranges = Vec::new();
        let mut delimiters = Vec::new();
        let mut work = 0;
        for index in first..=last {
            let (row, source, _) = self.rows.at(index);
            work += 2 * (row.literal_links.len() + row.literal_delimiters.len());
            delimiters.extend(
                row.literal_delimiters
                    .iter()
                    .map(|r| source + r.start..source + r.end),
            );
            ranges.extend(
                row.literal_links
                    .iter()
                    .map(|range| source + range.start..source + range.end),
            );
        }
        PendingLinks {
            window,
            delimiters,
            ranges,
            work,
        }
    }

    pub(crate) fn restore_pending(&mut self, snapshot: &PendingLinks) -> usize {
        let first = self.rows.locate(snapshot.window.start, false);
        let last = self.rows.locate(
            snapshot
                .window
                .end
                .saturating_sub(usize::from(snapshot.window.end > snapshot.window.start)),
            false,
        );
        let mut work = 0;
        for index in first..=last {
            let row = self.rows.metadata_mut(index);
            work += row.literal_links.len();
            row.literal_links.clear();
            work += row.literal_delimiters.len();
            row.literal_delimiters.clear();
        }
        for range in &snapshot.delimiters {
            let index = self.rows.locate(range.start, false);
            let (row, source, _) = self.rows.at(index);
            work += row.segments.len() + 1;
            let local = range.start - source..range.end - source;
            if row
                .segments
                .iter()
                .any(|s| s.source == local && !s.identity)
            {
                self.rows.metadata_mut(index).literal_delimiters.push(local);
            }
        }
        for range in &snapshot.ranges {
            let index = self.rows.locate(range.start, false);
            let (_, source, _) = self.rows.at(index);
            let local = range.start - source..range.end - source;
            let row = self.rows.metadata_mut(index);
            work += 1 + row.spans.len();
            if row.spans.iter().any(|span| {
                span.open.is_empty()
                    && span.close.is_empty()
                    && (span.open.end..span.close.start) == local
            }) {
                row.literal_links.push(local);
            }
        }
        work
    }

    pub(super) fn pending_display(&self, first: usize, last: usize) -> (Vec<DisplayRange>, usize) {
        let mut ranges = Vec::new();
        let mut work = 0;
        for index in first..=last {
            let (row, _, display) = self.rows.at(index);
            work += 2 * row.literal_links.len();
            ranges.extend(row.literal_links.iter().map(|range| DisplayRange {
                start: DisplayOffset(display + row.display_at(range.start)),
                end: DisplayOffset(display + row.display_at(range.end)),
            }));
        }
        (ranges, work)
    }

    pub(super) fn preserve_pending_display(
        &mut self,
        pending: Vec<DisplayRange>,
        change: DisplayRange,
        inserted: usize,
    ) -> usize {
        let removed = change.end.0 - change.start.0;
        let mut work = 0;
        for mut range in pending {
            work += 1;
            if range.end.0 < change.start.0 {
            } else if range.start.0 > change.end.0 {
                range.start.0 = range.start.0 - removed + inserted;
                range.end.0 = range.end.0 - removed + inserted;
            } else {
                if change.start.0 <= range.start.0 && range.end.0 <= change.end.0 && inserted == 0 {
                    continue;
                }
                range.start.0 = range.start.0.min(change.start.0);
                range.end.0 = range.end.0.max(change.end.0) - removed + inserted;
            }
            let index = self.rows.locate(range.start.0, true);
            let (row, _, display) = self.rows.at(index);
            work += row.spans.len();
            let local = row
                .spans
                .iter()
                .find(|span| {
                    span.open.is_empty()
                        && span.close.is_empty()
                        && display + row.display_at(span.open.end) == range.start.0
                        && display + row.display_at(span.close.start) <= range.end.0
                })
                .map(|span| span.open.end..span.close.start);
            if let Some(local) = local {
                self.rows.metadata_mut(index).literal_links.push(local);
            }
        }
        work
    }

    pub(super) fn suppressed_link(&self, row: &Row, span: &Span, _display: usize) -> bool {
        span.open.is_empty()
            && span.close.is_empty()
            && row
                .literal_links
                .contains(&(span.open.end..span.close.start))
    }

    pub(super) fn link_is_pending(&self, range: DisplayRange) -> bool {
        let (row, _, display) = self.rows.at(self.rows.locate(range.start.0, true));
        row.literal_links.iter().any(|link| {
            display + row.display_at(link.start) == range.start.0
                && display + row.display_at(link.end) == range.end.0
        })
    }

    pub(crate) fn finish_link_input(
        &mut self,
        input: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        caret: usize,
    ) -> usize {
        let mut work = 0;
        let word_bytes: usize = self
            .display
            .chars_at(self.display.byte_to_char(caret))
            .reversed()
            .take_while(|ch| !ch.is_whitespace())
            .map(char::len_utf8)
            .sum();
        let word = DisplayRange {
            start: DisplayOffset(caret - word_bytes),
            end: DisplayOffset(caret),
        };
        if action == crate::InputAction::Typing
            && !inserted.is_empty()
            && !inserted.chars().last().unwrap().is_whitespace()
        {
            let (links, query_work) = self.all_link_ranges(word);
            work += links.len() + query_work;
            for link in links {
                let index = self.rows.locate(link.start.0, true);
                let (row, _, display) = self.rows.at(index);
                work += row.spans.len() + row.literal_links.len();
                let bare = row
                    .spans
                    .iter()
                    .find(|span| {
                        matches!(span.kind, SpanKind::Link(_))
                            && span.open.is_empty()
                            && span.close.is_empty()
                            && display + row.display_at(span.open.end) == link.start.0
                            && display + row.display_at(span.close.start) == link.end.0
                    })
                    .map(|span| span.open.end..span.close.start);
                if let Some(bare) = bare {
                    if link.end.0 <= caret
                        && link.start.0 < input.start.0 + inserted.len()
                        && !row.literal_links.contains(&bare)
                    {
                        self.rows.metadata_mut(index).literal_links.push(bare);
                    }
                }
            }
        }
        if inserted.contains(char::is_whitespace) {
            let ended = caret
                - inserted
                    .rsplit(char::is_whitespace)
                    .next()
                    .unwrap_or("")
                    .len();
            let preceding: usize = self
                .display
                .chars_at(self.display.byte_to_char(input.start.0))
                .reversed()
                .take_while(|ch| !ch.is_whitespace())
                .map(char::len_utf8)
                .sum();
            let start = input.start.0 - preceding;
            let first = self.rows.locate(start, true);
            let last = self.rows.locate(ended, true);
            for index in first..=last {
                let (row, _, display) = self.rows.at(index);
                work += 2 * row.literal_links.len();
                let keep = row
                    .literal_links
                    .iter()
                    .filter(|range| {
                        !(start <= display + row.display_at(range.start)
                            && display + row.display_at(range.end) <= ended)
                    })
                    .cloned()
                    .collect();
                self.rows.metadata_mut(index).literal_links = keep;
            }
        }
        work
    }
}

impl Projection {
    pub(crate) fn install_delimiters(&mut self, ranges: Vec<Range<usize>>) -> usize {
        let mut work = 0;
        for range in ranges {
            let index = self.rows.locate(range.start, false);
            let (_, source, _) = self.rows.at(index);
            let row = self.rows.metadata_mut(index);
            let local = range.start - source..range.end - source;
            work += 1 + row.literal_delimiters.len();
            if !row.literal_delimiters.contains(&local) {
                row.literal_delimiters.push(local);
            }
        }
        work
    }

    pub(super) fn retained_delimiters(
        &self,
        first: usize,
        last: usize,
        edit: &SourceEdit,
    ) -> (Vec<Range<usize>>, usize) {
        let mut ranges = Vec::new();
        let mut work = 0;
        for index in first..=last {
            let (row, base, _) = self.rows.at(index);
            for local in &row.literal_delimiters {
                work += 2;
                let mut range = base + local.start..base + local.end;
                if range.end <= edit.range.start.0 {
                } else if edit.range.end.0 <= range.start {
                    range.start = range.start - edit.removed.len() + edit.inserted.len();
                    range.end = range.end - edit.removed.len() + edit.inserted.len();
                } else {
                    continue;
                }
                ranges.push(range);
            }
        }
        (ranges, work)
    }
}
