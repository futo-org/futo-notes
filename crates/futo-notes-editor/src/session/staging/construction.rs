//! One current source/resolver/pending/physical context constructor.
use super::*;

impl EditorSession {
    pub(in crate::session) fn stage_with_context(
        &self,
        raw: &str,
        window: Range<usize>,
        exact: bool,
    ) -> Result<Self, EditorError> {
        let physical_tail = if exact {
            self.physical_tail_at(window.end)
        } else {
            PhysicalTail::Unknown
        };
        let (winners, work) = if exact {
            self.projection.reference_winners(window.clone())
        } else {
            (
                Vec::new(),
                crate::inline::references::ReferenceWork::default(),
            )
        };
        let mut projection = crate::inline::Projection::with_references(
            raw,
            self.projection.references.clone(),
            &winners,
            work,
        );
        projection.catalog = self.projection.catalog.clone();
        projection.references_complete = exact
            && self.projection.references_complete
            && window.start == 0
            && window.end == self.source.len_bytes();
        if exact {
            let mut pending = self.projection.pending_links(window.clone());
            pending
                .ranges
                .retain(|range| window.start <= range.start && range.end <= window.end);
            projection.initial_link_metadata_items += pending.work + pending.ranges.len();
            for range in &mut pending.ranges {
                range.start -= window.start;
                range.end -= window.start;
            }
            pending
                .delimiters
                .retain(|range| window.start <= range.start && range.end <= window.end);
            projection.initial_link_metadata_items += pending.delimiters.len();
            for range in &mut pending.delimiters {
                range.start -= window.start;
                range.end -= window.start;
            }
            let mut guards = Vec::new();
            for word in &pending.guarded_words {
                projection.initial_link_metadata_items += 2;
                if window.start <= word.envelope.start && word.envelope.end <= window.end {
                    let (word, work) = word.map(&(0..raw.len()), &mut |range| {
                        (
                            range
                                .start
                                .checked_sub(window.start)
                                .zip(range.end.checked_sub(window.start))
                                .map(|(a, z)| a..z),
                            2,
                        )
                    })?;
                    projection.initial_link_metadata_items += work;
                    guards.push(word);
                } else if word.envelope.start < window.end && window.start < word.envelope.end {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            pending.guarded_words = guards;
            let mut origins = Vec::new();
            for origin in &pending.typed_inputs {
                projection.initial_link_metadata_items += 2;
                if window.start <= origin.opener.start && origin.word.end <= window.end {
                    let (origin, work) = origin.map(&(0..raw.len()), &mut |range| {
                        (
                            range
                                .start
                                .checked_sub(window.start)
                                .zip(range.end.checked_sub(window.start))
                                .map(|(a, z)| a..z),
                            2,
                        )
                    })?;
                    projection.initial_link_metadata_items += work;
                    origins.push(origin);
                } else if origin.opener.start < window.end && window.start < origin.word.end {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            pending.typed_inputs = origins;
            pending.window = 0..raw.len();
            let guard_work = if !pending.has_words() {
                EditWork::default()
            } else {
                let source = ropey::Rope::from_str(raw);
                let mut work = projection.validate_word_origins(&source, &pending)?;
                work.materialized_source_bytes += raw.len();
                work
            };
            // No materialization in the empty path. Nonempty source copies are
            // carried with planning's existing initial copied-byte accounting.
            projection.initial_link_metadata_items += guard_work.link_metadata_items;
            projection.initial_link_copied_bytes += guard_work.materialized_source_bytes;
            projection.initial_link_metadata_items += projection.restore_pending(&pending);
        }
        let mut staged = Self::with_projection(raw, Revision(0), self.clock.clone(), projection);
        let origin = if exact {
            if let Some(origin) = &self.context.origin {
                Some(crate::inline::references::SourceOrigin {
                    source: origin.source.clone(),
                    start: origin.start + window.start,
                })
            } else {
                self.projection.references_complete.then(|| {
                    crate::inline::references::SourceOrigin {
                        source: self.source.clone(),
                        start: window.start,
                    }
                })
            }
        } else {
            None
        };
        staged.projection.initial_link_metadata_items += usize::from(origin.is_some());
        staged.context = StageContext {
            before: self.stage_boundary(window.start, false),
            after: self.stage_boundary(window.end, true),
            origin,
            physical_tail,
            original_canonical: false,
            leading_list_prose: if exact {
                self.capture_leading_list_prose(window.start)
            } else {
                None
            },
            fence_edge: if exact {
                self.capture_fence_edge(&window)
            } else {
                None
            },
        };
        Ok(staged)
    }
}
