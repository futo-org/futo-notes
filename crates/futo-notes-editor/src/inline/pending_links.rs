//! Unfinished typed URLs are row-local transient meaning. Exact source remains
//! bare; reopening interprets it normally. History snapshots only touched rows.
use super::{
    row::{Row, Span, SpanKind},
    Projection,
};
use crate::{DisplayOffset, DisplayRange, SourceEdit, SourceRange};
use std::ops::Range;

mod capture;
pub(super) use capture::retain_row_fields;
mod snapshot;
mod witness;
pub(crate) use snapshot::PendingLinks;
pub(crate) use witness::PendingLinkWitness;

impl Projection {
    /// A derived body owns only fields wholly inside its physical input window.
    /// Query actual indexed rows and charge each visited node and field.
    pub(crate) fn pending_body(
        &self,
        window: Range<usize>,
    ) -> Result<PendingLinks, crate::EditorError> {
        let mut result = PendingLinks {
            window: window.clone(),
            ranges: Vec::new(),
            delimiters: Vec::new(),
            guarded_words: Vec::new(),
            typed_inputs: Vec::new(),
            work: 0,
        };
        let mut at = window.start;
        loop {
            let (row, base, _, visits) = self.rows.source_row_with_work(at);
            result.work += visits + 1;
            for (fields, output) in [
                (&row.literal_links, &mut result.ranges),
                (&row.literal_delimiters, &mut result.delimiters),
            ] {
                for field in fields {
                    result.work += 3;
                    let range = base + field.start..base + field.end;
                    if window.start <= range.start && range.end <= window.end {
                        output.push(range);
                    } else if range.start < window.end && window.start < range.end {
                        return Err(crate::EditorError::UnrepresentableFormat);
                    }
                }
            }
            result.capture_body_guards(row, base)?;
            result.capture_body_origins(row, base)?;
            let end = base + row.source_len;
            if end >= window.end || end <= at {
                break;
            }
            at = end;
        }
        Ok(result)
    }

    /// Prepare only complete retained URL identities. User-overwritten glyphs
    /// are new canonical fields; untouched identities without lineage reject.
    pub(crate) fn retained_input_pending(
        &self,
        before: &PendingLinks,
        edit: &SourceEdit,
        correspondence: &super::SourceCorrespondence,
        input: DisplayRange,
    ) -> Result<PendingLinks, crate::EditorError> {
        let mut result = PendingLinks {
            window: before.after_window(edit),
            ranges: Vec::new(),
            delimiters: Vec::new(),
            guarded_words: Vec::new(),
            typed_inputs: Vec::new(),
            work: 0,
        };
        for field in &before.ranges {
            result.work += 1;
            let mapped = if field.end <= edit.range.start.0 {
                Some(field.clone())
            } else if edit.range.end.0 <= field.start {
                result.work += 2;
                Some(
                    field.start - edit.removed.len() + edit.inserted.len()
                        ..field.end - edit.removed.len() + edit.inserted.len(),
                )
            } else {
                let (mapped, work) = correspondence.retained_range(field.clone());
                result.work += work;
                mapped
            };
            if let Some(mapped) = mapped {
                result.ranges.push(mapped);
            } else {
                let (retired, work) = correspondence.word_was_retired(field);
                result.work += work;
                if retired {
                    continue;
                }
                // A changed source step wholly inside this URL changes its
                // identity directly; no note-global display lookup is needed.
                result.work += 1;
                if field.start <= edit.range.start.0
                    && edit.range.end.0 <= field.end
                    && (!edit.removed.is_empty() || !edit.inserted.is_empty())
                {
                    continue;
                }
                let mut display_at = |at| {
                    let (row, base, display, visits) = self.rows.source_row_with_work(at);
                    let (local, segments) = row.display_at_with_work(at - base);
                    result.work += visits + segments;
                    display + local
                };
                let start = display_at(field.start);
                let end = display_at(field.end);
                let overwritten = input.start.0 < end && start < input.end.0
                    || input.start == input.end && start < input.start.0 && input.start.0 < end;
                if !overwritten {
                    return Err(crate::EditorError::UnrepresentableFormat);
                }
            }
        }
        Ok(result)
    }

    /// Merge prevalidated retained fields with canonical new/fallback fields.
    /// No late failure, and finish_link_input still owns intent retirement.
    pub(crate) fn merge_input_pending(&mut self, retained: &PendingLinks) -> usize {
        let mut current = self.pending_links(retained.window.clone());
        let mut work = current.work + retained.work;
        for (fields, prepared) in [
            (&mut current.ranges, &retained.ranges),
            (&mut current.delimiters, &retained.delimiters),
        ] {
            work += 2 * prepared.len();
            fields.extend(prepared.iter().cloned());
            fields.sort_unstable_by(|a, b| {
                work += 1;
                (a.start, a.end).cmp(&(b.start, b.end))
            });
            fields.dedup_by(|a, b| {
                work += 1;
                a == b
            });
        }
        work += 5 * retained.guarded_words.len();
        current.guarded_words = retained.guarded_words.clone();
        work += 5 * retained.typed_inputs.len();
        current.typed_inputs = retained.typed_inputs.clone();
        work + self.restore_pending(&current)
    }

    /// Exact canonical command-owned bodies were validated before acceptance.
    /// Group by owning row and visit each field once, preserving every foreign
    /// identity. These ranges are retirement evidence, never target mappings.
    pub(crate) fn retire_pending_links(&mut self, ranges: &[Range<usize>]) -> usize {
        let mut work = 0;
        let mut index = 0;
        while index < ranges.len() {
            let (row, base, visits) = self.rows.source_metadata_mut_with_work(ranges[index].start);
            work += visits;
            let first = index;
            let end = base + row.source_len;
            while index < ranges.len() && ranges[index].start < end {
                work += 1;
                index += 1;
            }
            row.literal_links.retain(|field| {
                work += 3;
                let key = (base + field.start, base + field.end);
                ranges[first..index]
                    .binary_search_by(|range| {
                        work += 1;
                        (range.start, range.end).cmp(&key)
                    })
                    .is_err()
            });
        }
        work
    }

    pub(crate) fn pending_for_source_edit(&self, edit: SourceRange) -> PendingLinks {
        #[cfg(test)]
        let visits = super::coordinate_work_tests::visits();
        let (first, a) = self.rows.locate_with_work(edit.start.0, false);
        let (last, z) = self.rows.locate_with_work(edit.end.0, false);
        let first = first.saturating_sub(1);
        let last = (last + 1).min(self.rows.len() - 1);
        let (_, start, _, b) = self.rows.at_with_work(first);
        let (row, end, _, c) = self.rows.at_with_work(last);
        #[cfg(test)]
        super::coordinate_work_tests::query("pending-neighbors", visits, a + z + b + c);
        let mut pending = self.pending_links(start..end + row.source_len);
        pending.work += a + z + b + c;
        pending
    }

    pub(super) fn pending_display(&self, first: usize, last: usize) -> (Vec<DisplayRange>, usize) {
        #[cfg(test)]
        let visits = super::coordinate_work_tests::visits();
        let mut ranges = Vec::new();
        let mut work = 0;
        for index in first..=last {
            let (row, _, display, nodes) = self.rows.at_with_work(index);
            work += nodes;
            for range in &row.literal_links {
                let (start, a) = row.display_at_with_work(range.start);
                let (end, z) = row.display_at_with_work(range.end);
                work += 2 + a + z;
                ranges.push(DisplayRange {
                    start: DisplayOffset(display + start),
                    end: DisplayOffset(display + end),
                });
            }
        }
        #[cfg(test)]
        super::coordinate_work_tests::query("pending-display", visits, work);
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
                    pending_span(span)
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
        matches!(span.kind, SpanKind::Link(_))
            && row
                .literal_links
                .contains(&(span.open.end..span.close.start))
    }

    pub(super) fn link_is_pending_with_work(&self, range: DisplayRange) -> (bool, usize) {
        #[cfg(test)]
        let visits = super::coordinate_work_tests::visits();
        let (row, _, display, mut work) = self.rows.display_row_with_work(range.start.0);
        let pending = row.literal_links.iter().any(|link| {
            work += 1;
            let (start, visits) = row.display_at_with_work(link.start);
            work += visits;
            if display + start != range.start.0 {
                return false;
            }
            let (end, visits) = row.display_at_with_work(link.end);
            work += visits;
            display + end == range.end.0
        });
        #[cfg(test)]
        super::coordinate_work_tests::query("link-pending", visits, work);
        (pending, work)
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
        if matches!(
            action,
            crate::InputAction::Typing | crate::InputAction::CompositionCommit
        ) && !inserted.is_empty()
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
    pub(crate) fn install_delimiters(
        &mut self,
        ranges: impl IntoIterator<Item = Range<usize>>,
    ) -> usize {
        let mut work = 0;
        for range in ranges {
            work += 1;
            let index = self.rows.locate(range.start, false);
            let (_, source, _) = self.rows.at(index);
            let row = self.rows.metadata_mut(index);
            let local = range.start - source..range.end - source;
            let segment = row.segments.partition_point(|segment| {
                work += 1;
                segment.source.start < local.start
            });
            let valid = row.segments.get(segment).is_some_and(|segment| {
                work += 1;
                segment.source == local && !segment.identity
            });
            if !valid {
                continue;
            }
            let position =
                row.literal_delimiters
                    .binary_search_by_key(&(local.start, local.end), |range| {
                        work += 1;
                        (range.start, range.end)
                    });
            if let Err(position) = position {
                work += row.literal_delimiters.len() - position;
                row.literal_delimiters.insert(position, local);
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

// Only explicitly supplied transient identities use this predicate. Loaded
// links never enroll here. A surviving verified marker may render a formatted
// label as several canonical explicit spans, each owning its complete body.
fn pending_span(span: &Span) -> bool {
    matches!(&span.kind, SpanKind::Link(target) if target.reference.is_none() && target.title.is_none())
}
