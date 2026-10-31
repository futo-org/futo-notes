//! Known original identities share one prepared transformation within this attempt.
use super::*;
mod requests;
use crate::inline::guarded_words::{CanonicalUri, CodeWordIdentity};
use requests::Role;
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
    /// Original canonical Code markers are captured independently of the final candidate.
    pub fn validate_original(
        &mut self,
        session: &EditorSession,
        original: &crate::inline::PendingLinks,
    ) -> Result<EditWork, EditorError> {
        let mut work = EditWork::default();
        let requests = self.requests(original, &mut work)?;
        let ranges: Vec<_> = requests
            .iter()
            .map(|request| request.range.clone())
            .collect();
        work.link_metadata_items += 2 * ranges.len() + usize::from(!ranges.is_empty());
        let (uris, codes, parsed) = session.projection.relink_owned_uris(&ranges, 0, None)?;
        charge(&mut work, parsed);
        for (request, uri) in requests.iter().zip(&uris) {
            work.link_metadata_items += 1;
            match (request.original, uri.as_ref(), request.role) {
                (Some(original), Some(uri), _) if same(original, uri, &mut work) => {}
                (None, None, Role::Typed(_)) => {}
                _ => return Err(EditorError::UnrepresentableFormat),
            }
        }
        self.codes = codes;
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
        let requests = self.requests(&self.pending, &mut work)?;
        let ranges: Vec<_> = requests
            .iter()
            .map(|request| request.range.clone())
            .collect();
        work.link_metadata_items += 2 * ranges.len() + usize::from(!ranges.is_empty());
        let (uris, _, parsed) =
            staged
                .projection
                .relink_owned_uris(&ranges, origin, Some(&self.codes))?;
        charge(&mut work, parsed);
        let mut prepared = Vec::with_capacity(requests.len());
        work.link_metadata_items += usize::from(!requests.is_empty());
        for (request, uri) in requests.into_iter().zip(uris) {
            work.link_metadata_items += 1;
            let identity = match (request.original, uri, request.role) {
                (Some(original), Some(uri), _) => {
                    Some(identities.prepare(original, request.program, uri, &mut work)?)
                }
                (None, None, Role::Typed(_)) => None,
                _ => {
                    eprintln!("301-uri-class FIRST candidate class rejected role={} original={} range={:?}",
                        match request.role { Role::Guard(_) => "Guard", Role::Typed(_) => "Typed" },
                        request.original.is_some(), request.range);
                    return Err(EditorError::UnrepresentableFormat);
                }
            };
            prepared.push((request.role, identity));
            work.link_metadata_items += 2;
        }
        for (role, identity) in prepared {
            work.link_metadata_items += 1;
            match role {
                Role::Guard(index) => {
                    self.pending.guarded_words[index].identity =
                        identity.ok_or(EditorError::UnrepresentableFormat)?
                }
                Role::Typed(index) => self.pending.typed_inputs[index].uri = identity,
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
            let (actual, visits) =
                staged
                    .projection
                    .pending_link_witnesses(&ranges)
                    .map_err(|error| {
                        eprintln!(
                            "301-uri-class FIRST pending-Link witness rejected ranges={ranges:?}"
                        );
                        error
                    })?;
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
