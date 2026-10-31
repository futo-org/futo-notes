//! A supplied plain Typed seed is local to one actual source boundary.
use super::*;
use std::ops::Range;

pub(in crate::session::relink) struct PlainTyped {
    opener: Range<usize>,
    word: Range<usize>,
    original: String,
    pub(super) expected: String,
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
        proof: &PlainTyped,
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
    pub(super) fn capture_plain_typed(
        &mut self,
        session: &EditorSession,
        original: &crate::inline::PendingLinks,
        rewritten: &str,
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
            let text = session.source.byte_slice(input.word.clone()).to_string();
            work.materialized_source_bytes += text.len();
            let (plain, visits) = session.projection.plain_relink_typed(input, &text, 0);
            work.link_metadata_items += visits;
            if !plain {
                self.plain_typed.push(None);
                continue;
            }
            // Original identity atoms plus actual complete canonical emission
            // give this expected body BEFORE any candidate interpretation.
            let expected = rewritten
                .get(self.pending.typed_inputs[index].word.clone())
                .ok_or(EditorError::UnrepresentableFormat)?
                .to_owned();
            work.link_copied_bytes += expected.len();
            self.plain_typed.push(Some(PlainTyped {
                opener: input.opener.clone(),
                word: input.word.clone(),
                original: text,
                expected,
            }));
            work.link_metadata_items += 11;
        }
        Ok(())
    }
    pub(super) fn require_plain_typed(
        &self,
        staged: &EditorSession,
        origin: usize,
        index: usize,
        displayed: &str,
        work: &mut EditWork,
    ) -> Result<&PlainTyped, EditorError> {
        work.link_metadata_items += 1;
        let proof = self
            .plain_typed
            .get(index)
            .and_then(Option::as_ref)
            .ok_or(EditorError::UnrepresentableFormat)?;
        if !same_text(&proof.expected, displayed, work) {
            return Err(EditorError::UnrepresentableFormat);
        }
        // B maps this whole opener/word only with actual byte-copy evidence.
        // Its final mapped range is used here, never the pre-spelling offset.
        let (plain, visits) = staged.projection.plain_relink_typed(
            &self.pending.typed_inputs[index],
            &proof.expected,
            origin,
        );
        work.link_metadata_items += visits;
        if !plain {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(proof)
    }
}
