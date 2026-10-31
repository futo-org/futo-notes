//! Known original identities share one prepared transformation within this attempt.
use super::*;
use crate::inline::guarded_words::{CanonicalUri, CodeWordIdentity};
use std::{collections::HashMap, sync::Arc};

#[derive(Default)]
pub(super) struct Identities {
    entries: HashMap<usize, Entry>,
}
struct Entry {
    original: Arc<CodeWordIdentity>,
    transformed: Arc<CodeWordIdentity>,
    program: Vec<(usize, usize)>,
}
impl Identities {
    fn prepare(
        &mut self,
        original: &Arc<CodeWordIdentity>,
        program: &[(usize, usize)],
        candidate: CanonicalUri,
        work: &mut EditWork,
    ) -> Result<Arc<CodeWordIdentity>, EditorError> {
        work.link_metadata_items += 1;
        let key = Arc::as_ptr(original) as usize;
        if let Some(entry) = self.entries.get(&key) {
            work.link_metadata_items += 4 + program.len().min(entry.program.len());
            if !Arc::ptr_eq(original, &entry.original)
                || program != entry.program
                || !same(&entry.transformed, &candidate, work)
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            return Ok(entry.transformed.clone());
        }
        work.link_metadata_items += 4 + 2 * program.len();
        work.link_copied_bytes += candidate.displayed.len();
        let transformed = Arc::new(CodeWordIdentity {
            displayed: Arc::from(candidate.displayed),
            meaning: candidate.meaning,
        });
        self.entries.insert(
            key,
            Entry {
                original: original.clone(),
                transformed: transformed.clone(),
                program: program.to_vec(),
            },
        );
        Ok(transformed)
    }
}
fn same(original: &CodeWordIdentity, candidate: &CanonicalUri, work: &mut EditWork) -> bool {
    work.link_metadata_items += 4;
    original.displayed.len() == candidate.displayed.len()
        && original
            .displayed
            .bytes()
            .zip(candidate.displayed.bytes())
            .all(|(a, b)| {
                work.link_metadata_items += 1;
                a == b
            })
        && original.meaning.destination.len() == candidate.meaning.destination.len()
        && original
            .meaning
            .destination
            .bytes()
            .zip(candidate.meaning.destination.bytes())
            .all(|(a, b)| {
                work.link_metadata_items += 1;
                a == b
            })
        && original.meaning.title == candidate.meaning.title
        && original.meaning.reference == candidate.meaning.reference
}
impl rewrite::Fields {
    /// Original Code coverage is required independently of the final candidate.
    pub fn validate_original(
        &self,
        session: &EditorSession,
        original: &crate::inline::PendingLinks,
    ) -> Result<EditWork, EditorError> {
        let mut words = Vec::new();
        let mut work = EditWork::default();
        for (word, changed) in original.guarded_words.iter().zip(&self.changed_guards) {
            work.link_metadata_items += 1;
            if *changed {
                words.push(word.clone());
                work.link_metadata_items += 5;
            }
        }
        let (uris, parsed) = session.projection.relink_code_uris(&words, 0)?;
        charge(&mut work, parsed);
        for (word, uri) in words.iter().zip(&uris) {
            if !same(&word.identity, uri, &mut work) {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(work)
    }
    /// This runs before any affected witness check or pending metadata restore.
    pub fn prepare_candidate(
        &mut self,
        staged: &EditorSession,
        origin: usize,
        identities: &mut Identities,
    ) -> Result<EditWork, EditorError> {
        let mut work = EditWork::default();
        let mut words = Vec::new();
        for (word, changed) in self.pending.guarded_words.iter().zip(&self.changed_guards) {
            work.link_metadata_items += 1;
            if *changed {
                words.push(word.clone());
                work.link_metadata_items += 5;
            }
        }
        let (uris, parsed) = staged.projection.relink_code_uris(&words, origin)?;
        charge(&mut work, parsed);
        let mut uris = uris.into_iter();
        for (index, word) in self.pending.guarded_words.iter_mut().enumerate() {
            work.link_metadata_items += 1;
            if self.changed_guards[index] {
                word.identity = identities.prepare(
                    &word.identity,
                    &self.programs[index],
                    uris.next().ok_or(EditorError::UnrepresentableFormat)?,
                    &mut work,
                )?;
            }
        }
        if self.changed_links.iter().any(|changed| {
            work.link_metadata_items += 1;
            *changed
        }) {
            let mut ranges = Vec::with_capacity(self.witnesses.len());
            work.link_metadata_items += 1;
            for witness in &self.witnesses {
                let a = witness
                    .body
                    .start
                    .checked_sub(origin)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                let z = witness
                    .body
                    .end
                    .checked_sub(origin)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                ranges.push(a..z);
                work.link_metadata_items += 2;
            }
            let (actual, visits) = staged.projection.pending_link_witnesses(&ranges)?;
            work.link_metadata_items += visits;
            if actual.len() != self.witnesses.len() {
                return Err(EditorError::UnrepresentableFormat);
            }
            for ((expected, actual), changed) in self
                .witnesses
                .iter_mut()
                .zip(actual)
                .zip(&self.changed_links)
            {
                work.link_metadata_items += 7;
                if expected.open != (origin + actual.open.start..origin + actual.open.end)
                    || expected.close != (origin + actual.close.start..origin + actual.close.end)
                    || expected.body != (origin + actual.body.start..origin + actual.body.end)
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
                if *changed {
                    expected.meaning = actual.meaning;
                }
            }
        }
        Ok(work)
    }
}
