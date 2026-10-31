//! Known original identities share one prepared transformation within this attempt.
use super::*;
mod requests;
mod typed;
use crate::inline::guarded_words::{CanonicalUri, CodeWordIdentity, RelinkWord};
use requests::Role;
use std::{collections::HashMap, sync::Arc};
pub(super) use typed::{Seeds, TypedAtoms};

#[derive(Default)]
pub(super) struct Identities {
    entries: HashMap<usize, Entry>,
}
struct Entry {
    original: Arc<CodeWordIdentity>,
    transformed: Outcome,
    program: Vec<(usize, usize)>,
}
enum Outcome {
    Uri(Arc<CodeWordIdentity>),
    Literal(Arc<str>),
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
                || !matches!(&entry.transformed, Outcome::Uri(uri) if same(uri, &candidate, work))
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            let Outcome::Uri(uri) = &entry.transformed else {
                return Err(EditorError::UnrepresentableFormat);
            };
            return Ok(uri.clone());
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
                transformed: Outcome::Uri(transformed.clone()),
                program: program.to_vec(),
            },
        );
        Ok(transformed)
    }
    fn retire(
        &mut self,
        original: &Arc<CodeWordIdentity>,
        program: &[(usize, usize)],
        expected: &str,
        work: &mut EditWork,
    ) -> Result<(), EditorError> {
        work.link_metadata_items += 1;
        let key = Arc::as_ptr(original) as usize;
        if let Some(entry) = self.entries.get(&key) {
            work.link_metadata_items += 4 + program.len().min(entry.program.len());
            if !Arc::ptr_eq(original, &entry.original)
                || program != entry.program
                || !matches!(&entry.transformed, Outcome::Literal(text) if same_text(text, expected, work))
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            return Ok(());
        }
        work.link_metadata_items += 4 + 2 * program.len();
        work.link_copied_bytes += expected.len();
        self.entries.insert(
            key,
            Entry {
                original: original.clone(),
                transformed: Outcome::Literal(Arc::from(expected)),
                program: program.to_vec(),
            },
        );
        Ok(())
    }
}
fn same_text(a: &str, b: &str, work: &mut EditWork) -> bool {
    work.link_metadata_items += 1;
    a.len() == b.len()
        && a.bytes().zip(b.bytes()).all(|(a, b)| {
            work.link_metadata_items += 1;
            a == b
        })
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
        accumulate_planning_work(&mut work, parsed);
        let mut guard_atoms: Vec<Option<Vec<crate::inline::guarded_words::ValidationAtom>>> =
            std::iter::repeat_with(|| None)
                .take(original.guarded_words.len())
                .collect();
        work.link_metadata_items += guard_atoms.len();
        for (request_index, (request, uri)) in requests.iter().zip(&uris).enumerate() {
            work.link_metadata_items += 1;
            match (request.original, uri, request.role) {
                (Some(original), RelinkWord::Uri(uri), _) if same(original, uri, &mut work) => {}
                (None, RelinkWord::Literal(_), Role::Typed(_)) => {}
                _ => return Err(EditorError::UnrepresentableFormat),
            }
            if let Role::Guard(index) = request.role {
                let word = &original.guarded_words[index];
                let (atoms, captured) = session.projection.capture_relink_guard_atoms(
                    word.inner.clone(),
                    &codes[request_index],
                    0,
                )?;
                accumulate_planning_work(&mut work, captured);
                let mut offset = 0;
                for atom in atoms.iter().flatten() {
                    work.link_metadata_items += 1;
                    let expected = word
                        .identity
                        .displayed
                        .get(offset..offset + atom.displayed.len())
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    if !same_text(expected, &atom.displayed, &mut work) {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    offset += atom.displayed.len();
                }
                if atoms.is_some() && offset != word.identity.displayed.len() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                guard_atoms[index] = atoms;
            }
        }
        self.capture_typed_atoms(session, original, &mut work)?;
        self.guard_atoms = guard_atoms;
        self.codes = codes;
        Ok(work)
    }
    /// This runs before any affected witness check or pending metadata restore.
    pub fn prepare_candidate(
        &mut self,
        staged: &EditorSession,
        origin: usize,
        identities: &mut Identities,
        seeds: &mut Seeds,
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
        accumulate_planning_work(&mut work, parsed);
        let mut prepared = Vec::with_capacity(requests.len());
        work.link_metadata_items += usize::from(!requests.is_empty());
        let mut retired_guards = Vec::new();
        let mut retired_requests = Vec::new();
        let mut retired_envelopes = Vec::new();
        let mut retired_origins = Vec::new();
        for (request_index, (request, uri)) in requests.into_iter().zip(uris).enumerate() {
            work.link_metadata_items += 1;
            let identity = match (request.original, uri, request.role) {
                (Some(original), RelinkWord::Uri(uri), _) => {
                    Some(identities.prepare(original, request.program, uri, &mut work)?)
                }
                (None, RelinkWord::Literal(_), Role::Typed(_)) => None,
                (None, RelinkWord::Uri(uri), Role::Typed(index)) => {
                    let proof =
                        self.require_typed_atoms(staged, origin, index, &uri.displayed, &mut work)?;
                    Some(seeds.prepare(proof, request.program, uri, &mut work)?)
                }
                (Some(original), RelinkWord::Literal(displayed), Role::Typed(index)) => {
                    let proof =
                        self.require_typed_atoms(staged, origin, index, &displayed, &mut work)?;
                    identities.retire(original, request.program, &proof.expected, &mut work)?;
                    retired_origins.push(index);
                    retired_requests.push(request_index);
                    work.link_metadata_items += 2;
                    continue;
                }
                (Some(original), RelinkWord::Literal(displayed), Role::Guard(index)) => {
                    let word = &self.pending.guarded_words[index];
                    let atoms = self.guard_atoms[index]
                        .as_deref()
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    work.link_metadata_items += staged.projection.validate_relink_guard_atoms(
                        atoms,
                        &self.codes[request_index],
                        origin,
                    )?;
                    let mut expected = String::new();
                    for atom in atoms {
                        expected.push_str(&atom.displayed);
                        work.link_metadata_items += 1;
                        work.link_copied_bytes += atom.displayed.len();
                    }
                    if !same_text(&displayed, &expected, &mut work) {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    identities.retire(original, request.program, &expected, &mut work)?;
                    retired_guards.push(index);
                    retired_requests.push(request_index);
                    retired_envelopes.push(word.envelope.clone());
                    work.link_metadata_items += 5;
                    continue;
                }
                _ => return Err(EditorError::UnrepresentableFormat),
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
        work.link_metadata_items += staged
            .projection
            .validate_literal_relink_envelopes(&retired_envelopes, origin)?;
        // Every indexed validation above is complete. Keep all guard/program
        // vectors coherent, while concrete scoped pending output remains even
        // when the last word is removed.
        for index in retired_guards.into_iter().rev() {
            work.link_metadata_items += 13 * (self.pending.guarded_words.len() - index);
            self.pending.guarded_words.remove(index);
            self.changed_guards.remove(index);
            self.programs.remove(index);
            self.guard_atoms.remove(index);
        }
        for index in retired_origins.into_iter().rev() {
            work.link_metadata_items += 23 * (self.pending.typed_inputs.len() - index);
            self.pending.typed_inputs.remove(index);
            self.changed_origins.remove(index);
            self.origin_programs.remove(index);
            self.plain_typed.remove(index);
        }
        for index in retired_requests.into_iter().rev() {
            work.link_metadata_items += 3 * (self.codes.len() - index);
            self.codes.remove(index);
        }
        Ok(work)
    }
}
