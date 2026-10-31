//! A supplied plain Typed seed is local to one actual source boundary.
use super::*;
use std::ops::Range;

pub(in crate::session::relink) struct TypedAtoms {
    opener: Range<usize>,
    word: Range<usize>,
    original: String,
    pub(in crate::session::relink) atoms: Vec<crate::inline::guarded_words::ValidationAtom>,
    pub(in crate::session::relink) expected: String,
}
#[derive(Default)]
pub(in crate::session::relink) struct Seeds {
    entries: HashMap<(usize, usize, usize), Seed>,
}
struct Seed {
    original: String,
    program: Vec<(usize, usize)>,
    prepared: Arc<CodeWordIdentity>,
}
impl Seeds {
    pub(super) fn prepare(
        &mut self,
        proof: &TypedAtoms,
        program: &[(usize, usize)],
        candidate: CanonicalUri,
        work: &mut EditWork,
    ) -> Result<Arc<CodeWordIdentity>, EditorError> {
        let key = (proof.opener.start, proof.word.start, proof.word.end);
        work.link_metadata_items += 4;
        if let Some(found) = self.entries.get(&key) {
            work.link_metadata_items += 2 + program.len().min(found.program.len());
            if !same_text(&proof.original, &found.original, work)
                || program != found.program
                || !same(&found.prepared, &candidate, work)
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            return Ok(found.prepared.clone());
        }
        work.link_metadata_items += 7 + 2 * program.len();
        work.link_copied_bytes += proof.original.len() + candidate.displayed.len();
        let prepared = Arc::new(CodeWordIdentity {
            displayed: Arc::from(candidate.displayed),
            meaning: candidate.meaning,
        });
        self.entries.insert(
            key,
            Seed {
                original: proof.original.clone(),
                program: program.to_vec(),
                prepared: prepared.clone(),
            },
        );
        Ok(prepared)
    }
}
impl rewrite::Fields {
    pub(super) fn capture_typed_atoms(
        &mut self,
        session: &EditorSession,
        original: &crate::inline::PendingLinks,
        work: &mut EditWork,
    ) -> Result<(), EditorError> {
        self.plain_typed = Vec::with_capacity(original.typed_inputs.len());
        work.link_metadata_items += usize::from(!original.typed_inputs.is_empty());
        for (index, input) in original.typed_inputs.iter().enumerate() {
            work.link_metadata_items += 1;
            if !self.changed_origins[index] {
                self.plain_typed.push(None);
                continue;
            }
            // Original row validation already proves this supplied opener's
            // literal semantics. The new proof additionally requires its
            // actual one-byte copied source representation.
            work.link_metadata_items += 2;
            if input.opener.len() != 1
                || session.source.byte_slice(input.opener.clone()).byte(0) != b'<'
            {
                self.plain_typed.push(None);
                continue;
            }
            let (atoms, captured) =
                session
                    .projection
                    .capture_relink_guard_atoms(input.word.clone(), &[], 0)?;
            accumulate_planning_work(work, captured);
            let Some(atoms) = atoms else {
                self.plain_typed.push(None);
                continue;
            };
            let mut text = String::new();
            for atom in &atoms {
                text.push_str(&atom.displayed);
                work.link_copied_bytes += atom.displayed.len();
                work.link_metadata_items += 1;
            }
            self.plain_typed.push(Some(TypedAtoms {
                opener: input.opener.clone(),
                word: input.word.clone(),
                original: text,
                atoms,
                expected: String::new(),
            }));
            work.link_metadata_items += 14;
        }
        Ok(())
    }
    pub(super) fn require_typed_atoms(
        &self,
        staged: &EditorSession,
        origin: usize,
        index: usize,
        displayed: &str,
        work: &mut EditWork,
    ) -> Result<&TypedAtoms, EditorError> {
        work.link_metadata_items += 1;
        let proof = self
            .plain_typed
            .get(index)
            .and_then(Option::as_ref)
            .ok_or(EditorError::UnrepresentableFormat)?;
        if !same_text(&proof.expected, displayed, work) {
            return Err(EditorError::UnrepresentableFormat);
        }
        // Retained nonidentity atoms have actual whole copied ranges through
        // Wiki and B; emitted identity scalars still need the final parser's
        // identity witness. Neither equal display nor an offset hull suffices.
        work.link_metadata_items +=
            staged
                .projection
                .validate_relink_guard_atoms(&proof.atoms, &[], origin)?;
        let input = &self.pending.typed_inputs[index];
        let envelope = input.opener.start..input.word.end;
        let expected = format!("<{}", proof.expected);
        work.link_copied_bytes += expected.len();
        work.link_metadata_items += staged
            .projection
            .validate_retired_link_texts(&[(&envelope, expected.as_str(), &[])], origin)?;
        Ok(proof)
    }
}
