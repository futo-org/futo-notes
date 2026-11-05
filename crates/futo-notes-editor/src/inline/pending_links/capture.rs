//! Scoped current source snapshots and infallible prepared metadata restore.
use super::*;

impl Projection {
    /// Source-coordinate snapshot for one original source window. Staging must
    /// relocate these source positions only when its raw window is exact.
    pub(crate) fn pending_links(&self, window: Range<usize>) -> PendingLinks {
        let (first, first_work) = self.rows.locate_with_work(window.start, false);
        let (last, last_work) = self.rows.locate_with_work(
            window
                .end
                .saturating_sub(usize::from(window.end > window.start)),
            false,
        );
        let mut ranges = Vec::new();
        let mut delimiters = Vec::new();
        let mut guarded_words = Vec::new();
        let mut typed_inputs = Vec::new();
        let mut work = first_work + last_work;
        for index in first..=last {
            let (row, source, _, nodes) = self.rows.at_with_work(index);
            work += nodes;
            work += 2 * (row.literal_links.len() + row.literal_delimiters.len());
            delimiters.extend(
                row.literal_delimiters
                    .iter()
                    .map(|r| source + r.start..source + r.end),
            );
            for word in &row.guarded_words {
                let mut word = word.clone();
                work += 5 + word.relocate(source);
                guarded_words.push(word);
            }
            for origin in &row.typed_inputs {
                let mut origin = origin.clone();
                work += 5 + origin.relocate(source);
                typed_inputs.push(origin);
            }
            ranges.extend(
                row.literal_links
                    .iter()
                    .map(|range| source + range.start..source + range.end),
            );
        }
        PendingLinks {
            window,
            delimiters,
            guarded_words,
            typed_inputs,
            ranges,
            work,
        }
    }

    pub(crate) fn restore_pending(&mut self, snapshot: &PendingLinks) -> usize {
        self.restore_pending_changed(snapshot).0
    }

    /// [`Self::restore_pending`], also saying whether any row's transient
    /// fields changed: when none did, an earlier projection query still holds.
    pub(crate) fn restore_pending_changed(&mut self, snapshot: &PendingLinks) -> (usize, bool) {
        let mut cleared = false;
        let (first, first_work) = self.rows.locate_with_work(snapshot.window.start, false);
        let (last, last_work) = self.rows.locate_with_work(
            snapshot
                .window
                .end
                .saturating_sub(usize::from(snapshot.window.end > snapshot.window.start)),
            false,
        );
        let mut work = first_work + last_work;
        for index in first..=last {
            let (_, source, _, nodes) = self.rows.at_with_work(index);
            let (row, mutation) = self.rows.metadata_mut_with_work(index);
            work += nodes + mutation;
            // A final parent paragraph can also own source outside the exact
            // child output. Never clear that foreign pending metadata.
            let inside = |range: &Range<usize>| {
                snapshot.window.start <= source + range.start
                    && source + range.end <= snapshot.window.end
            };
            let held = row.literal_links.len()
                + row.guarded_words.len()
                + row.typed_inputs.len()
                + row.literal_delimiters.len();
            row.literal_links.retain(|range| {
                work += 1;
                !inside(range)
            });
            row.guarded_words.retain(|word| {
                work += 3;
                !inside(&word.envelope)
            });
            row.typed_inputs.retain(|origin| {
                work += 3;
                !inside(&origin.envelope())
            });
            row.literal_delimiters.retain(|range| {
                work += 1;
                !inside(range)
            });
            cleared |= held
                != row.literal_links.len()
                    + row.guarded_words.len()
                    + row.typed_inputs.len()
                    + row.literal_delimiters.len();
        }
        work += self.restore_guard_words(snapshot);
        work += self.restore_typed_origins(snapshot);
        work += self.install_delimiters(snapshot.delimiters.iter().cloned());
        for range in &snapshot.ranges {
            let (row, source, nodes) = self.rows.source_metadata_mut_with_work(range.start);
            let local = range.start - source..range.end - source;
            work += nodes;
            work += 1;
            if row.spans.iter().any(|span| {
                work += 1;
                pending_span(span) && (span.open.end..span.close.start) == local
            }) {
                row.literal_links.push(local);
            }
        }
        (work, cleared || snapshot.has_fields())
    }
}

/// Capture during the canonical affected-row walk: empty words add no second
/// row traversal, index query or copy just because their private types exist.
pub(in crate::inline) fn retain_row_fields(
    row: &Row,
    base: usize,
    edit: &SourceEdit,
    guards: &mut Vec<crate::inline::guarded_words::GuardedWord>,
    origins: &mut Vec<crate::inline::typed_angle::TypedAngleOrigin>,
    work: &mut usize,
) {
    for word in &row.guarded_words {
        let mut word = word.clone();
        *work += 5 + word.relocate(base);
        let (mapped, visits) = word.raw_edit(edit);
        *work += visits;
        if let Some(word) = mapped {
            guards.push(word);
        }
    }
    for origin in &row.typed_inputs {
        let mut origin = origin.clone();
        *work += 5 + origin.relocate(base);
        let (mapped, visits) = origin.raw_edit(edit);
        *work += visits;
        if let Some(origin) = mapped {
            origins.push(origin);
        }
    }
}

impl Projection {
    pub(crate) fn validate_word_origins(
        &self,
        source: &ropey::Rope,
        snapshot: &PendingLinks,
    ) -> Result<crate::EditWork, crate::EditorError> {
        let mut work = self.validate_guard_words(source, snapshot)?;
        let typed = self.validate_typed_origins(source, snapshot)?;
        work.materialized_source_bytes += typed.materialized_source_bytes;
        work.parsed_source_bytes += typed.parsed_source_bytes;
        work.link_metadata_items += typed.link_metadata_items;
        work.link_copied_bytes += typed.link_copied_bytes;
        Ok(work)
    }
}
