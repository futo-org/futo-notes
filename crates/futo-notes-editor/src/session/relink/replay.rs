//! One attempt-local canonical interpretation follows actual original history edits.
use super::*;
use crate::inline::PendingLinks;

pub(super) struct Replay {
    pub session: EditorSession,
    pub work: EditWork,
}
impl Replay {
    pub fn new(owner: &EditorSession, source: &str) -> Result<Self, EditorError> {
        let session = owner.stage_source(source, 0..source.len())?;
        let work = EditWork {
            parsed_source_bytes: session.projection.initial_parse_work,
            link_metadata_items: session.projection.initial_link_metadata_items,
            link_copied_bytes: session.projection.initial_link_copied_bytes,
            ..EditWork::default()
        };
        Ok(Self { session, work })
    }
    pub fn step(&mut self, entry: &HistoryEntry, forward: bool) -> Result<(), EditorError> {
        let (expected, inserted, pending) = if forward {
            (&entry.removed, &entry.inserted, &entry.after_links)
        } else {
            (&entry.inserted, &entry.removed, &entry.before_links)
        };
        let edit = self.session.prepare_source(
            self.session.revision(),
            SourceRange {
                start: entry.range.start,
                end: SourceOffset(entry.range.start.0 + expected.len()),
            },
            inserted,
        )?;
        if edit.removed != *expected {
            return Err(EditorError::RecoveryMismatch);
        }
        let change = self.session.apply(&edit);
        charge(&mut self.work, change.work);
        // Temporary source records are not additional accepted user insertions.
        self.work.materialized_source_bytes += edit.inserted.len();
        self.restore(pending)
    }
    pub fn restore(&mut self, pending: &PendingLinks) -> Result<(), EditorError> {
        if pending.window.start > pending.window.end
            || pending.window.end > self.session.source.len_bytes()
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        let checked = self
            .session
            .projection
            .validate_word_origins(&self.session.source, pending)?;
        charge(&mut self.work, checked);
        self.work.link_metadata_items += self.session.projection.restore_pending(pending);
        let actual = self
            .session
            .projection
            .pending_body(pending.window.clone())?;
        self.work.link_metadata_items += actual.work;
        let (guards, a) = pending.same_guards(&actual);
        let (origins, z) = pending.same_typed_inputs(&actual);
        self.work.link_metadata_items += a + z;
        if !guards || !origins {
            return Err(EditorError::UnrepresentableFormat);
        }
        for (wanted, found) in [
            (&pending.ranges, &actual.ranges),
            (&pending.delimiters, &actual.delimiters),
        ] {
            let mut wanted = wanted.clone();
            let mut found = found.clone();
            self.work.link_metadata_items += 2 * (wanted.len() + found.len());
            for fields in [&mut wanted, &mut found] {
                fields.sort_unstable_by(|a, b| {
                    self.work.link_metadata_items += 1;
                    (a.start, a.end).cmp(&(b.start, b.end))
                });
            }
            self.work.link_metadata_items += wanted.len().min(found.len());
            if wanted != found {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(())
    }
}
