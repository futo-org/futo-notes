//! The same scoped source snapshot transports every typed input origin.
use super::*;
use crate::inline::{row::Row, PendingLinks, Projection};
impl PendingLinks {
    pub(crate) fn prepare_typed_inputs(
        &mut self,
        before: &Self,
        edit: &SourceEdit,
        update: Option<&crate::inline::guarded_words::GuardUpdate>,
    ) -> Result<(), EditorError> {
        for origin in &before.typed_inputs {
            self.work += 2;
            if let Some(update) = update {
                if update.before.start <= origin.opener.start
                    && origin.word.end <= update.before.end
                {
                    continue;
                }
                if origin.opener.start < update.before.end && update.before.start < origin.word.end
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            let (mapped, work) = origin.raw_edit(edit);
            self.work += work;
            self.typed_inputs
                .push(mapped.ok_or(EditorError::UnrepresentableFormat)?);
        }
        if let Some(update) = update {
            self.work += 5 * update.typed_inputs.len();
            self.typed_inputs
                .extend(update.typed_inputs.iter().cloned());
            self.typed_inputs.sort_unstable_by(|a, b| {
                self.work += 1;
                (a.opener.start, a.word.end).cmp(&(b.opener.start, b.word.end))
            });
        }
        Ok(())
    }

    pub(crate) fn same_typed_inputs(&self, other: &Self) -> (bool, usize) {
        let mut work = 1;
        if self.typed_inputs.len() != other.typed_inputs.len() {
            return (false, work);
        }
        for (a, b) in self.typed_inputs.iter().zip(&other.typed_inputs) {
            let (same, visits) = a.same(b);
            work += visits;
            if !same {
                return (false, work);
            }
        }
        (true, work)
    }

    pub(crate) fn capture_body_origins(
        &mut self,
        row: &Row,
        base: usize,
    ) -> Result<(), EditorError> {
        for origin in &row.typed_inputs {
            self.work += 2;
            let range = base + origin.opener.start..base + origin.word.end;
            if self.window.start <= range.start && range.end <= self.window.end {
                let mut origin = origin.clone();
                self.work += 5 + origin.relocate(base);
                self.typed_inputs.push(origin);
            } else if range.start < self.window.end && self.window.start < range.end {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(())
    }
}
impl Projection {
    /// Install the same already validated payload; clearing is performed inside
    /// the ordinary scoped restore loop, including a real Some(empty) update.
    pub(crate) fn restore_typed_origins(&mut self, snapshot: &PendingLinks) -> usize {
        let mut work = 0;
        for origin in &snapshot.typed_inputs {
            let (row, base, visits) = self.rows.source_metadata_mut_with_work(origin.opener.start);
            work += visits + 5;
            row.typed_inputs.push(TypedAngleOrigin {
                opener: origin.opener.start - base..origin.opener.end - base,
                word: origin.word.start - base..origin.word.end - base,
                uri: origin.uri.clone(),
            });
        }
        work
    }
}

impl Projection {
    pub(crate) fn validate_typed_origins(
        &self,
        source: &ropey::Rope,
        snapshot: &PendingLinks,
    ) -> Result<crate::EditWork, EditorError> {
        let mut work = crate::EditWork::default();
        if snapshot.typed_inputs.is_empty() {
            return Ok(work);
        }
        let mut at = 0;
        let mut previous = snapshot.window.start;
        let mut guard = 0;
        let mut identities = std::collections::HashSet::with_capacity(snapshot.typed_inputs.len());
        work.link_metadata_items += 1;
        while at < snapshot.typed_inputs.len() {
            let first = &snapshot.typed_inputs[at];
            work.link_metadata_items += 5;
            if first.opener.is_empty()
                || first.word.is_empty()
                || first.opener.end != first.word.start
                || first.opener.start < snapshot.window.start
                || first.word.end > snapshot.window.end
                || first.word.end > source.len_bytes()
            {
                return Err(EditorError::UnrepresentableFormat);
            }

            let (row, base, _, visits) = self.rows.source_row_with_work(first.opener.start);
            work.link_metadata_items += visits;
            let mut local = Vec::new();
            while let Some(origin) = snapshot.typed_inputs.get(at) {
                work.link_metadata_items += 1;
                if base + row.source_len <= origin.opener.start {
                    break;
                }
                work.link_metadata_items += 4;
                if origin.opener.start < previous
                    || origin.word.end > snapshot.window.end
                    || origin.word.end > base + row.source_len
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
                if let Some(uri) = &origin.uri {
                    work.link_metadata_items += 1;
                    if !identities.insert(Arc::as_ptr(uri)) {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                }
                previous = origin.word.end;
                while guard < snapshot.guarded_words.len()
                    && snapshot.guarded_words[guard].envelope.end <= origin.opener.start
                {
                    work.link_metadata_items += 1;
                    guard += 1;
                }
                if snapshot.guarded_words.get(guard).is_some_and(|word| {
                    work.link_metadata_items += 1;
                    word.envelope.start < origin.word.end
                }) {
                    return Err(EditorError::UnrepresentableFormat);
                }
                work.link_metadata_items += 5;
                local.push(TypedAngleOrigin {
                    opener: origin.opener.start - base..origin.opener.end - base,
                    word: origin
                        .word
                        .start
                        .checked_sub(base)
                        .ok_or(EditorError::UnrepresentableFormat)?
                        ..origin
                            .word
                            .end
                            .checked_sub(base)
                            .ok_or(EditorError::UnrepresentableFormat)?,
                    uri: origin.uri.clone(),
                });
                at += 1;
            }
            // Segment extents and display belong to this actual canonical row;
            // validation needs no additional whole-row source materialization.
            work.link_metadata_items += super::validate_row(row.source_len, row, &local)?;
        }
        Ok(work)
    }
}
