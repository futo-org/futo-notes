use super::*;

fn canonical_reset(
    engine: &EditorSession,
    edit: &SourceEdit,
    previous_revision: Revision,
    previous_display_bytes: usize,
    work: &mut BoundedWork,
) -> ViewChange {
    let range = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(engine.projection.display.len_bytes()),
    };
    let (projection, query) = engine.projection.query_with_work(engine.revision(), range);
    let records = projection.correspondence.len()
        + projection.blocks.len()
        + projection.runs.len()
        + projection.links.len();
    let formats = projection
        .runs
        .iter()
        .map(|run| run.formats.len())
        .sum::<usize>();
    let languages = projection
        .blocks
        .iter()
        .map(|block| block.language.as_ref().map_or(0, String::len))
        .sum::<usize>();
    let link_bytes = projection
        .links
        .iter()
        .map(|link| link.destination.len() + link.title.as_ref().map_or(0, String::len))
        .sum::<usize>();
    // query's link owner supplies parser/copy/visit work; charge other
    // returned records and real payload copies separately. This is no
    // CPU/allocator claim and remains a whole-document operation.
    work.parsed_source_bytes += query.parsed;
    work.metadata_items += query.items + records + formats + 1;
    work.copied_bytes += query.copied + languages + projection.text.len() * 2;
    work.returned_records += records + 1;
    work.returned_text_bytes += projection.text.len() * 2 + languages + link_bytes;
    let inserted = projection.text.clone();
    ViewChange {
        previous_revision,
        revision: edit.revision,
        range: DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(previous_display_bytes),
        },
        inserted,
        selection: engine.selection(),
        affinity: engine.affinity(),
        work: crate::EditWork {
            materialized_source_bytes: work.inspected_source_bytes,
            inserted_bytes: edit.inserted.len(),
            parsed_source_bytes: work.parsed_source_bytes,
            link_metadata_items: work.metadata_items,
            link_copied_bytes: work.copied_bytes,
        },
        projection,
    }
}

impl PortableBoundedSession {
    /// Deliberately proportional. A withheld candidate keeps its exact source
    /// edit and becomes one real canonical full-display reset, released only by
    /// the legacy acceptance barrier. Old bounded callback authority ends here.
    pub fn into_full(self) -> Result<(PortableSession, BoundedWork), PortableBoundedExitError> {
        if self.waiting.is_some() {
            return Err(PortableBoundedExitError {
                session: Box::new(self),
                error: PortableError::Busy,
            });
        }
        if self.pending.is_none() && !self.reset_required {
            if let Err(error) = self.ready() {
                return Err(PortableBoundedExitError {
                    session: Box::new(self),
                    error,
                });
            }
        }
        if let Some((edit, _, _)) = &self.pending {
            if edit.revision != self.engine.source_authority().revision
                || (self.accepted != edit.previous_revision && self.accepted != edit.revision)
            {
                return Err(PortableBoundedExitError {
                    session: Box::new(self),
                    error: PortableError::InvalidAcknowledgement,
                });
            }
        }
        let previous_display_bytes = self.pending.as_ref().map(|(_, _, frame)| {
            let (removed, inserted) = match frame {
                BoundedFrame::Literal(change) => (
                    change.range.end.0 - change.range.start.0,
                    change.inserted.len(),
                ),
                BoundedFrame::Progress(BoundedProgress::Change(change)) => (
                    change.range.end.0 - change.range.start.0,
                    change.inserted.len(),
                ),
                BoundedFrame::Progress(BoundedProgress::Status(_)) => (0, 0),
            };
            self.engine.display_bytes() - inserted + removed
        });
        let (engine, mut work) = self.engine.materialize();
        let pending = self.pending.map(|(edit, _, _)| {
            let change = canonical_reset(
                &engine,
                &edit,
                self.displayed,
                previous_display_bytes.unwrap(),
                &mut work,
            );
            (edit, change)
        });
        Ok((
            PortableSession {
                engine,
                token: self.mode.request.token,
                sequence: self.sequence,
                waiting: None,
                pending,
                displayed: self.displayed,
                accepted: self.accepted,
                durable: self.durable,
                paused: self.paused,
                relink: self.relink,
                bounded_entry: None,
            },
            work,
        ))
    }
}
