//! Controlled emitted URI transformations are not copied-source lineage.
use super::*;
use crate::inline::PendingLinkWitness;
use std::ops::Range;

pub(super) struct Part {
    range: RewriteRange,
    emitted: bool,
}
pub(super) fn coverage(bodies: Vec<RetainedBody>, replaced: &[Replacement]) -> (Vec<Part>, usize) {
    let mut work = 1;
    let mut result = Vec::with_capacity(bodies.len() + replaced.len());
    let mut copied = bodies.into_iter().peekable();
    let mut emitted = replaced.iter().peekable();
    while copied.peek().is_some() || emitted.peek().is_some() {
        work += 1;
        if copied.peek().is_some_and(|a| {
            emitted
                .peek()
                .is_none_or(|b| a.before.start < b.range.before.start)
        }) {
            let a = copied.next().unwrap();
            result.push(Part {
                range: RewriteRange {
                    before: a.before,
                    after: a.after,
                },
                emitted: false,
            });
            work += 2;
        } else {
            let b = emitted.next().unwrap();
            result.push(Part {
                range: RewriteRange {
                    before: b.range.before.clone(),
                    after: b.range.after.clone(),
                },
                emitted: true,
            });
            work += 5;
        }
    }
    (result, work)
}

pub(in crate::session::relink) struct Fields {
    pub pending: PendingLinks,
    pub witnesses: Vec<PendingLinkWitness>,
    pub changed_guards: Vec<bool>,
    pub programs: Vec<Vec<(usize, usize)>>,
    pub codes: Vec<Vec<crate::inline::guarded_words::CodeWitness>>,
    pub changed_links: Vec<bool>,
    pub changed_origins: Vec<bool>,
    pub origin_programs: Vec<Vec<(usize, usize)>>,
}
impl Rewrite {
    pub fn code_witnesses(
        &self,
        codes: &mut [Vec<crate::inline::guarded_words::CodeWitness>],
    ) -> Result<usize, EditorError> {
        if codes.is_empty() {
            return Ok(0);
        }
        let mut work = 0;
        for step in &self.steps {
            work += 1;
            for owner in codes.iter_mut() {
                work += 1;
                for witness in owner {
                    witness.open = copied(step, witness.open.clone(), &mut work)?;
                    witness.close = copied(step, witness.close.clone(), &mut work)?;
                    work += 2;
                }
            }
        }
        Ok(work)
    }
    pub fn fields(
        &self,
        pending: &PendingLinks,
        witnesses: Vec<PendingLinkWitness>,
    ) -> Result<Fields, EditorError> {
        let mut result = Fields {
            pending: pending.clone(),
            changed_guards: vec![false; pending.guarded_words.len()],
            programs: vec![Vec::new(); pending.guarded_words.len()],
            codes: Vec::new(),
            changed_links: vec![false; witnesses.len()],
            changed_origins: vec![false; pending.typed_inputs.len()],
            origin_programs: vec![Vec::new(); pending.typed_inputs.len()],
            witnesses,
        };
        result.pending.work = 2 * (1 + pending.ranges.len() + pending.delimiters.len())
            + 5 * (pending.guarded_words.len() + pending.typed_inputs.len())
            + 3
            + result.programs.len()
            + result.changed_guards.len()
            + result.changed_links.len()
            + 2
            + 2 * result.changed_origins.len();
        for (generation, step) in self.steps.iter().enumerate() {
            let (a, x) = step.position(result.pending.window.start, Affinity::Backward)?;
            let (z, y) = step.position(result.pending.window.end, Affinity::Forward)?;
            result.pending.work += x + y;
            result.pending.window = a..z;
            for field in &mut result.pending.ranges {
                let (mapped, _, work) = step.field(field.clone())?;
                *field = mapped;
                result.pending.work += work;
            }
            for field in &mut result.pending.delimiters {
                *field = copied(step, field.clone(), &mut result.pending.work)?;
            }
            for (index, (word, changed)) in result
                .pending
                .guarded_words
                .iter_mut()
                .zip(&mut result.changed_guards)
                .enumerate()
            {
                let open = copied(
                    step,
                    word.envelope.start..word.inner.start,
                    &mut result.pending.work,
                )?;
                let close = copied(
                    step,
                    word.inner.end..word.envelope.end,
                    &mut result.pending.work,
                )?;
                let (inner, emitted, work) = step.field(word.inner.clone())?;
                result.pending.work += work + 4;
                if open.end != inner.start || inner.end != close.start {
                    return Err(EditorError::UnrepresentableFormat);
                }
                word.envelope = open.start..close.end;
                word.inner = inner;
                *changed |= emitted > 0;
                if emitted > 0 {
                    result.programs[index].push((generation, emitted));
                    result.pending.work += 3;
                }
            }
            for (index, origin) in result.pending.typed_inputs.iter_mut().enumerate() {
                origin.opener = copied(step, origin.opener.clone(), &mut result.pending.work)?;
                let (word, emitted, work) = step.field(origin.word.clone())?;
                result.pending.work += work + 2;
                if origin.opener.end != word.start {
                    return Err(EditorError::UnrepresentableFormat);
                }
                origin.word = word;
                if emitted > 0 {
                    if origin.uri.is_none() {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    result.changed_origins[index] = true;
                    result.origin_programs[index].push((generation, emitted));
                    result.pending.work += 4;
                }
            }
            for (witness, changed) in result.witnesses.iter_mut().zip(&mut result.changed_links) {
                witness.open = copied(step, witness.open.clone(), &mut result.pending.work)?;
                witness.close = copied(step, witness.close.clone(), &mut result.pending.work)?;
                let (body, emitted, work) = step.field(witness.body.clone())?;
                result.pending.work += work + 2;
                if witness.open.end != body.start || body.end != witness.close.start {
                    return Err(EditorError::UnrepresentableFormat);
                }
                witness.body = body;
                *changed |= emitted > 0;
            }
        }
        Ok(result)
    }
}
fn copied(step: &Step, field: Range<usize>, work: &mut usize) -> Result<Range<usize>, EditorError> {
    // Bare canonical spans have empty open/close at their actual body edges.
    if field.is_empty() {
        let (at, visits) = step.position(field.start, Affinity::Backward)?;
        *work += visits;
        return Ok(at..at);
    }
    let (mapped, visits) = step.copied.retained_range(field);
    *work += visits;
    mapped.ok_or(EditorError::UnrepresentableFormat)
}
impl Step {
    fn field(&self, field: Range<usize>) -> Result<(Range<usize>, usize, usize), EditorError> {
        let mut work = 1;
        let first = self.coverage.partition_point(|part| {
            work += 1;
            part.range.before.end <= field.start
        });
        let (mut source, mut output, mut start) = (field.start, None, None);
        let mut changed = 0;
        for part in &self.coverage[first..] {
            work += 1;
            if field.end <= source {
                break;
            }
            let range = &part.range;
            if range.before.start > source || source >= range.before.end {
                return Err(EditorError::UnrepresentableFormat);
            }
            let end = field.end.min(range.before.end);
            let (a, z) = if part.emitted {
                if source != range.before.start || end != range.before.end {
                    return Err(EditorError::UnrepresentableFormat);
                }
                changed += 1;
                (range.after.start, range.after.end)
            } else {
                (
                    range.after.start + source - range.before.start,
                    range.after.start + end - range.before.start,
                )
            };
            work += 7;
            if output.is_some_and(|old| old != a) {
                return Err(EditorError::UnrepresentableFormat);
            }
            start.get_or_insert(a);
            output = Some(z);
            source = end;
        }
        if source != field.end {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok((
            start
                .zip(output)
                .map(|(a, z)| a..z)
                .ok_or(EditorError::UnrepresentableFormat)?,
            changed,
            work,
        ))
    }
}
