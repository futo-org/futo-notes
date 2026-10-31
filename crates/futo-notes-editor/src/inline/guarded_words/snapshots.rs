//! Scoped guard snapshots move current source extents and logical identity together.
use super::*;
use crate::inline::{PendingLinks, Projection};

impl Projection {
    /// Validate the supplied current generation before any host acceptance.
    /// Empty payloads allocate nothing and never query canonical rows.
    pub(crate) fn validate_guard_words(
        &self,
        source: &ropey::Rope,
        snapshot: &PendingLinks,
    ) -> Result<crate::EditWork, crate::EditorError> {
        let mut work = crate::EditWork::default();
        if snapshot.guarded_words.is_empty() {
            return Ok(work);
        }
        let mut seen = std::collections::HashSet::with_capacity(snapshot.guarded_words.len());
        work.link_metadata_items += 1;
        let mut previous = snapshot.window.start;
        let mut at = 0;
        while at < snapshot.guarded_words.len() {
            let first = &snapshot.guarded_words[at];
            let (row, base, _, visits) = self.rows.source_row_with_work(first.envelope.start);
            work.link_metadata_items += visits;
            let mut local = Vec::new();
            while let Some(word) = snapshot.guarded_words.get(at) {
                work.link_metadata_items += 1;
                if base + row.source_len <= word.envelope.start {
                    break;
                }
                work.link_metadata_items += 5;
                if word.envelope.start < previous
                    || word.envelope.end > snapshot.window.end
                    || word.envelope.end > base + row.source_len
                    || !seen.insert(Arc::as_ptr(&word.identity))
                {
                    return Err(crate::EditorError::UnrepresentableFormat);
                }
                previous = word.envelope.end;
                work.link_metadata_items += 5;
                local.push(GuardedWord {
                    envelope: word.envelope.start - base..word.envelope.end - base,
                    inner: word
                        .inner
                        .start
                        .checked_sub(base)
                        .ok_or(crate::EditorError::UnrepresentableFormat)?
                        ..word
                            .inner
                            .end
                            .checked_sub(base)
                            .ok_or(crate::EditorError::UnrepresentableFormat)?,
                    identity: word.identity.clone(),
                });
                at += 1;
            }
            let raw = source.byte_slice(base..base + row.source_len).to_string();
            work.materialized_source_bytes += raw.len();
            work.link_metadata_items += super::validate_row(&raw, row, &local)?;
        }
        Ok(work)
    }

    /// Replace this exact current output scope. Some(empty) is a real clear,
    /// while callers represent no prepared ownership update with None.
    pub(crate) fn restore_guard_words(&mut self, snapshot: &PendingLinks) -> usize {
        let mut work = 0;
        for word in &snapshot.guarded_words {
            let (row, base, visits) = self.rows.source_metadata_mut_with_work(word.envelope.start);
            work += visits + 5;
            // Validation belongs to the prepared candidate before acceptance.
            // This is an infallible installation of that same source payload.
            row.guarded_words.push(GuardedWord {
                envelope: word.envelope.start - base..word.envelope.end - base,
                inner: word.inner.start - base..word.inner.end - base,
                identity: word.identity.clone(),
            });
        }
        work
    }

    pub(crate) fn retained_raw_guard_words(
        &self,
        first: usize,
        last: usize,
        edit: &crate::SourceEdit,
    ) -> (Vec<GuardedWord>, usize) {
        let mut result = Vec::new();
        let mut work = 0;
        for index in first..=last {
            let (row, base, _) = self.rows.at(index);
            for word in &row.guarded_words {
                let mut word = word.clone();
                work += 5 + word.relocate(base);
                let (mapped, visits) = word.raw_edit(edit);
                work += visits;
                if let Some(word) = mapped {
                    result.push(word);
                }
            }
        }
        (result, work)
    }
}

impl PendingLinks {
    pub(crate) fn capture_body_guards(
        &mut self,
        row: &crate::inline::row::Row,
        base: usize,
    ) -> Result<(), EditorError> {
        for word in &row.guarded_words {
            self.work += 2;
            let field = base + word.envelope.start..base + word.envelope.end;
            if self.window.start <= field.start && field.end <= self.window.end {
                let mut word = word.clone();
                self.work += 5 + word.relocate(base);
                self.guarded_words.push(word);
            } else if field.start < self.window.end && self.window.start < field.end {
                return Err(crate::EditorError::UnrepresentableFormat);
            }
        }
        Ok(())
    }

    /// The complete actual emitter replaces only its proven opening scope.
    /// Outside fields follow the actual compact source edit unchanged.
    pub(crate) fn prepare_guards(
        &mut self,
        before: &Self,
        edit: &crate::SourceEdit,
        update: Option<&GuardUpdate>,
    ) -> Result<(), EditorError> {
        for word in &before.guarded_words {
            self.work += 2;
            if let Some(update) = update {
                if update.before.start <= word.envelope.start
                    && word.envelope.end <= update.before.end
                {
                    continue;
                }
                if word.envelope.start < update.before.end
                    && update.before.start < word.envelope.end
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            let (mapped, work) = word.raw_edit(edit);
            self.work += work;
            self.guarded_words
                .push(mapped.ok_or(EditorError::UnrepresentableFormat)?);
        }
        if let Some(update) = update {
            if update.after.start < self.window.start || update.after.end > self.window.end {
                return Err(EditorError::UnrepresentableFormat);
            }
            self.work += 5 * update.words.len();
            self.guarded_words.extend(update.words.iter().cloned());
            self.guarded_words.sort_unstable_by(|a, b| {
                self.work += 1;
                (a.envelope.start, a.envelope.end).cmp(&(b.envelope.start, b.envelope.end))
            });
        }
        Ok(())
    }

    pub(crate) fn same_guards(&self, other: &Self) -> (bool, usize) {
        let mut work = 1;
        if self.guarded_words.len() != other.guarded_words.len() {
            return (false, work);
        }
        for (a, b) in self.guarded_words.iter().zip(&other.guarded_words) {
            let (same, visits) = a.same(b);
            work += visits;
            if !same {
                return (false, work);
            }
        }
        (true, work)
    }
}
