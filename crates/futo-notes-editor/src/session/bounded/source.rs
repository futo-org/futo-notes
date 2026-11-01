use super::*;

const MAX_RECORDS: usize = 32;
const MAX_BYTES: usize = 256;

/// Source acceptance does not depend on either endpoint's display generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedSourceAuthority {
    pub token: SessionToken,
    pub incarnation: u64,
    pub revision: Revision,
}

/// Identifiers select retained canonical metadata, never page-supplied meaning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoundedSourceOperation {
    Literal {
        unit: Option<usize>,
    },
    PrefixLiteral,
    RemoveCloser,
    RestoreCloser,
    /// An exact inverse of a finite contiguous accepted source-record suffix.
    Inverse {
        records: u8,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum SourceRegion {
    Body,
    Unit(usize),
    Prefix,
    Closer(bool),
}

pub(super) struct SourceRecord {
    pub(super) edit: SourceEdit,
    region: SourceRegion,
    operation: Option<BoundedSourceOperation>,
    suffix_delta: i64,
}

/// Consuming source-only endpoint. Its presentation cannot be queried or used
/// after worker source acceptance; materialization deliberately restores Full.
pub struct BoundedSourceSession {
    engine: BoundedEditorSession,
}
impl BoundedSourceSession {
    pub fn source_authority(&self) -> BoundedSourceAuthority {
        self.engine.source_authority()
    }
    pub fn source_text(&self) -> String {
        self.engine.source_text()
    }
    pub fn last_operation_work(&self) -> BoundedWork {
        self.engine.last_operation_work()
    }
    pub fn preparation_work(&self) -> BoundedWork {
        self.engine.preparation_work()
    }
    /// Ends source-worker authority. This endpoint never recorded page history;
    /// its returned full engine starts a fresh history lifetime. Canonical
    /// source/transient provenance survives the deliberate proportional replay.
    pub fn materialize_source(self) -> (EditorSession, BoundedWork) {
        let (mut engine, mut work) = self.engine.materialize();
        for group in engine.undo.iter().chain(&engine.redo) {
            work.retired_history_records += 1 + group.entries.len();
            for entry in &group.entries {
                work.retired_history_payload_bytes += entry.removed.len() + entry.inserted.len();
            }
        }
        engine.undo.clear();
        engine.redo.clear();
        engine.typing = None;
        engine.pending_formats = None;
        engine.bounded_work = work;
        (engine, work)
    }
    /// Validate and install only canonical source facts. This never advances
    /// page continuations, changes selection or guesses a history group.
    pub fn replay_bounded_source(
        &mut self,
        authority: BoundedSourceAuthority,
        edit: &SourceEdit,
        operation: &BoundedSourceOperation,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<BoundedWork, BoundedError> {
        let mut work = BoundedWork::default();
        let result = (|| {
            if authority != self.engine.source_authority() {
                return Err(BoundedError::StaleCursor);
            }
            let (region, delta) = self
                .engine
                .validate_source_operation(edit, operation, &mut work)?;
            accept(edit).map_err(|error| BoundedError::Editor(EditorError::Persistence(error)))?;
            self.engine
                .install_source(edit, region, Some(operation.clone()), delta);
            work.copied_bytes += edit.removed.len() + edit.inserted.len();
            work.metadata_items += 4;
            Ok(work)
        })();
        self.engine.last_operation = work;
        result
    }
}

impl BoundedEditorSession {
    pub(crate) fn require_source_witness(&mut self) {
        self.source_transport = true;
    }
    pub fn into_source_worker(self) -> BoundedSourceSession {
        BoundedSourceSession { engine: self }
    }
    pub fn source_authority(&self) -> BoundedSourceAuthority {
        BoundedSourceAuthority {
            token: self.token,
            incarnation: self.engine.bounded_incarnation,
            revision: self.engine.revision,
        }
    }

    pub fn last_source_operation(&self) -> Option<BoundedSourceOperation> {
        self.source_records.back()?.operation.clone()
    }

    fn validate_source_edit(
        &self,
        edit: &SourceEdit,
        work: &mut BoundedWork,
    ) -> Result<(), BoundedError> {
        // Limit before prepare_source copies foreign payload or source bytes.
        if edit.inserted.len() > MAX_BYTES
            || edit.removed.len() > MAX_BYTES
            || edit.range.end.0.saturating_sub(edit.range.start.0) > MAX_BYTES
        {
            return Err(BoundedError::Unsupported);
        }
        let prepared = self
            .engine
            .prepare_source(edit.previous_revision, edit.range, &edit.inserted)
            .map_err(BoundedError::Editor)?;
        work.copied_bytes += prepared.removed.len() + prepared.inserted.len();
        work.inspected_source_bytes += prepared.removed.len();
        if prepared != *edit {
            return Err(BoundedError::Editor(EditorError::RecoveryMismatch));
        }
        Ok(())
    }

    fn closer_range(&self) -> Option<std::ops::Range<usize>> {
        let progress = self.progress.as_ref()?;
        let start = self.code.body.end + progress.certificate.closer.start
            - progress.certificate.frame_source.start;
        Some(start..start + self.closer.len())
    }

    pub(super) fn direct_source_operation(
        &self,
        edit: &SourceEdit,
        work: &mut BoundedWork,
    ) -> Option<BoundedSourceOperation> {
        let empty = edit.range.start == edit.range.end;
        if let (Some(progress), Some(closer)) = (&self.progress, self.closer_range()) {
            let removed = progress.changed && !progress.restore;
            if !removed
                && edit.range.start.0 == closer.start
                && edit.range.end.0 == closer.end
                && edit.removed == self.closer
                && edit.inserted.is_empty()
            {
                return Some(BoundedSourceOperation::RemoveCloser);
            }
            if removed
                && empty
                && edit.range.start.0 == closer.start
                && edit.inserted == self.closer
            {
                return Some(BoundedSourceOperation::RestoreCloser);
            }
        }
        if !empty
            || !edit.removed.is_empty()
            || edit.inserted.len() > 4
            || edit.inserted.chars().count() != 1
            || edit.inserted.contains(['\r', '\n', '`', '~'])
            || Rope::from_str(&edit.inserted).len_lines() != 1
        {
            return None;
        }
        let at = edit.range.start.0;
        if self
            .progress
            .as_ref()
            .is_some_and(|progress| progress.certificate.has_crlf)
        {
            let before = at
                .checked_sub(1)
                .and_then(|at| self.engine.source.get_byte(at));
            let after = self.engine.source.get_byte(at);
            work.inspected_source_bytes +=
                usize::from(before.is_some()) + usize::from(after.is_some());
            if before == Some(b'\r') && after == Some(b'\n') {
                return None;
            }
        }
        if self.code.body.start <= at && at <= self.code.body.end {
            return Some(BoundedSourceOperation::Literal { unit: None });
        }
        if let Some(prefix) = &self.prefix {
            let start = self.engine.source.line_to_byte(prefix.source_line);
            let end = self.engine.source.line_to_byte(prefix.source_line + 1) - 1;
            if start <= at && at <= end && edit.inserted.chars().all(char::is_alphanumeric) {
                return Some(BoundedSourceOperation::PrefixLiteral);
            }
        }
        let progress = self.progress.as_ref()?;
        if !progress.changed || progress.restore {
            return None;
        }
        let line = self.engine.source.byte_to_line(at);
        let index = progress
            .certificate
            .units
            .partition_point(|unit| {
                work.metadata_items += 1;
                unit.source_lines.start <= line
            })
            .checked_sub(1)?;
        let unit = &progress.certificate.units[index];
        let range = progress::unit_source(
            &self.engine.source,
            unit,
            index + 1 == progress.certificate.units.len(),
        );
        (range.start <= at && at <= range.end)
            .then_some(BoundedSourceOperation::Literal { unit: Some(index) })
    }

    fn validate_source_operation(
        &self,
        edit: &SourceEdit,
        operation: &BoundedSourceOperation,
        work: &mut BoundedWork,
    ) -> Result<(SourceRegion, i64), BoundedError> {
        *work = BoundedWork {
            input_bytes: edit.inserted.len(),
            inspected_source_bytes: 0,
            copied_bytes: 0,
            metadata_items: 4,
            ..Default::default()
        };
        self.validate_source_edit(edit, work)?;
        let mut delta = 0;
        let region = match operation {
            BoundedSourceOperation::Inverse { records } => {
                let (inverse, region, effect) = self
                    .inverse_source(usize::from(*records), work)
                    .ok_or(BoundedError::Unsupported)?;
                delta = effect;
                if inverse != *edit {
                    return Err(BoundedError::Unsupported);
                }
                region
            }
            direct => {
                if self.direct_source_operation(edit, work).as_ref() != Some(direct) {
                    return Err(BoundedError::Unsupported);
                }
                match direct {
                    BoundedSourceOperation::Literal { unit: None } => SourceRegion::Body,
                    BoundedSourceOperation::Literal { unit: Some(index) } => {
                        delta = 1;
                        SourceRegion::Unit(*index)
                    }
                    BoundedSourceOperation::PrefixLiteral => SourceRegion::Prefix,
                    BoundedSourceOperation::RemoveCloser => SourceRegion::Closer(true),
                    BoundedSourceOperation::RestoreCloser => SourceRegion::Closer(false),
                    BoundedSourceOperation::Inverse { .. } => unreachable!(),
                }
            }
        };
        self.check_source_region(region)?;
        self.dirty_suffix
            .checked_add(delta)
            .ok_or(BoundedError::Unsupported)?;
        Ok((region, delta))
    }

    fn inverse_source(
        &self,
        count: usize,
        work: &mut BoundedWork,
    ) -> Option<(SourceEdit, SourceRegion, i64)> {
        if count == 0 || count > MAX_RECORDS {
            return None;
        }
        let mut transaction = crate::history::Transaction::new(&self.engine.source);
        let mut region = None;
        let mut bytes = 0;
        let mut start = usize::MAX;
        let mut end = 0;
        let mut found = 0;
        let mut effect = 0i64;
        for record in self.source_records.iter().rev().take(count) {
            let edit = &record.edit;
            work.metadata_items += 1;
            effect = effect.checked_sub(record.suffix_delta)?;
            bytes += edit.removed.len() + edit.inserted.len();
            start = start.min(edit.range.start.0);
            end = end.max(edit.range.start.0 + edit.inserted.len().max(edit.removed.len()));
            if bytes > MAX_BYTES
                || end - start > MAX_BYTES
                || region.is_some_and(|region| region != record.region)
            {
                return None;
            }
            region = Some(record.region);
            work.copied_bytes += edit.removed.len();
            transaction.apply(
                SourceRange {
                    start: edit.range.start,
                    end: SourceOffset(edit.range.start.0 + edit.inserted.len()),
                },
                &edit.removed,
            );
            found += 1;
        }
        if found != count {
            return None;
        }
        let (range, inserted) = transaction.finish();
        work.copied_bytes += inserted.len();
        let edit = self
            .engine
            .prepare_source(self.engine.revision, range, &inserted)
            .ok()?;
        work.copied_bytes += edit.inserted.len() + edit.removed.len();
        work.inspected_source_bytes += edit.removed.len();
        if edit.removed.len() > MAX_BYTES || edit.inserted.len() > MAX_BYTES {
            return None;
        }
        let region = match region? {
            SourceRegion::Closer(removed) => SourceRegion::Closer(!removed),
            region => region,
        };
        Some((edit, region, effect))
    }

    pub(super) fn check_source_region(&self, region: SourceRegion) -> Result<(), BoundedError> {
        if matches!(region, SourceRegion::Closer(false)) && self.dirty_suffix != 0 {
            return Err(BoundedError::Unsupported);
        }
        Ok(())
    }

    pub(super) fn prepare_page_source(
        &self,
        edit: &SourceEdit,
        region: SourceRegion,
        inverse_records: Option<usize>,
        work: &mut BoundedWork,
    ) -> Result<(Option<BoundedSourceOperation>, i64), BoundedError> {
        self.check_source_region(region)?;
        let mut delta = if matches!(region, SourceRegion::Unit(_)) {
            1
        } else {
            0
        };
        let operation = self.direct_source_operation(edit, work).or_else(|| {
            inverse_records.and_then(|records| {
                self.inverse_source(records, work)
                    .and_then(|(inverse, _, effect)| {
                        if inverse == *edit {
                            delta = effect;
                        }
                        (inverse == *edit).then_some(BoundedSourceOperation::Inverse {
                            records: records as u8,
                        })
                    })
            })
        });
        if self.source_transport && operation.is_none() {
            return Err(BoundedError::Unsupported);
        }
        self.dirty_suffix
            .checked_add(delta)
            .ok_or(BoundedError::Unsupported)?;
        work.metadata_items += 2;
        Ok((operation, delta))
    }

    pub(super) fn accept_page_source(
        &mut self,
        edit: &SourceEdit,
        region: SourceRegion,
        prepared: (Option<BoundedSourceOperation>, i64),
    ) {
        let (operation, delta) = prepared;
        self.install_source(edit, region, operation, delta);
    }

    fn install_source(
        &mut self,
        edit: &SourceEdit,
        region: SourceRegion,
        operation: Option<BoundedSourceOperation>,
        delta: i64,
    ) {
        self.dirty_suffix += delta;
        let a = self.engine.source.byte_to_char(edit.range.start.0);
        let z = self.engine.source.byte_to_char(edit.range.end.0);
        self.engine.source.remove(a..z);
        self.engine.source.insert(a, &edit.inserted);
        self.engine.revision = edit.revision;
        match region {
            SourceRegion::Prefix => self.shift_code_prefix(edit.removed.len(), edit.inserted.len()),
            SourceRegion::Body => {
                self.code.body.end = self.code.body.end - edit.removed.len() + edit.inserted.len();
                self.code.display.end =
                    self.code.display.end - edit.removed.len() + edit.inserted.len();
                self.code.whole.end =
                    self.code.whole.end - edit.removed.len() + edit.inserted.len();
            }
            SourceRegion::Closer(removed) => {
                self.code.whole.end =
                    self.code.whole.end - edit.removed.len() + edit.inserted.len();
                let progress = self.progress.as_mut().unwrap();
                progress.changed = true;
                progress.restore = !removed;
            }
            SourceRegion::Unit(_) => {}
        }
        self.source_records.push_back(SourceRecord {
            edit: edit.clone(),
            region,
            operation,
            suffix_delta: delta,
        });
    }
}
