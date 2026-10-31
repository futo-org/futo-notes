//! Source lineage is supplied only by the canonical wikilink emitter.
use super::*;
use crate::history::{SourcePoint, SourceSelection};
use crate::inline::{references::RetainedBody, PendingLinks, SourceCorrespondence};
use futo_notes_wikilinks::RewriteRange;
mod fields;
pub(super) use fields::Fields;

struct Replacement {
    range: RewriteRange,
    caret: super::positions::TargetCaret,
}
struct Step {
    input_len: usize,
    output_len: usize,
    copied: SourceCorrespondence,
    replaced: Vec<Replacement>,
    coverage: Vec<fields::Part>,
}
pub(super) struct Rewrite {
    pub source: String,
    steps: Vec<Step>,
    pub work: EditWork,
}
impl Rewrite {
    pub fn prepare(source: &str, relink: &OwnActionRelink) -> Result<Self, EditorError> {
        let mut output: Option<String> = None;
        let mut ids = relink.note_ids.clone();
        let mut work = EditWork::default();
        work.link_metadata_items += ids.len();
        work.link_copied_bytes += ids.iter().map(String::len).sum::<usize>();
        let mut steps = Vec::new();
        for (from, to) in &relink.mappings {
            let before = output.as_deref().unwrap_or(source);
            let observed = futo_notes_wikilinks::observe_wikilink_rewrite(before, from, to, &ids);
            work.link_metadata_items += observed.work.metadata_items;
            work.link_copied_bytes += observed.work.copied_bytes;
            work.materialized_source_bytes += observed.source.len();
            work.link_metadata_items += 1;
            if observed.input_len != before.len() {
                return Err(EditorError::UnrepresentableFormat);
            }
            let mut bodies = Vec::with_capacity(observed.copied.len());
            work.link_metadata_items += usize::from(!observed.copied.is_empty());
            for part in observed.copied {
                let old = before
                    .get(part.before.clone())
                    .ok_or(EditorError::UnrepresentableFormat)?;
                let new = observed
                    .source
                    .get(part.after.clone())
                    .ok_or(EditorError::UnrepresentableFormat)?;
                work.link_metadata_items += 4;
                if old.len() != new.len()
                    || !old.bytes().zip(new.bytes()).all(|(a, b)| {
                        work.link_metadata_items += 1;
                        a == b
                    })
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
                bodies.push(RetainedBody {
                    before: part.before,
                    after: part.after,
                });
            }
            let (copied, visits) = SourceCorrespondence::from_bodies(&bodies)?;
            work.link_metadata_items += visits;
            let mut replaced = Vec::with_capacity(observed.replaced.len());
            work.link_metadata_items += usize::from(!observed.replaced.is_empty());
            for range in observed.replaced {
                let old_target = before
                    .get(range.before.start + 2..range.before.end - 2)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                let new_target = observed
                    .source
                    .get(range.after.start + 2..range.after.end - 2)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                let (caret, visits) = super::positions::TargetCaret::new(old_target, new_target);
                work.link_metadata_items += visits + 4;
                replaced.push(Replacement { range, caret });
            }
            if from != to {
                let (coverage, visits) = fields::coverage(bodies, &replaced);
                work.link_metadata_items += visits;
                steps.push(Step {
                    input_len: observed.input_len,
                    output_len: observed.source.len(),
                    copied,
                    replaced,
                    coverage,
                });
            }
            output = Some(observed.source);
            if let Some(id) = ids.iter_mut().find(|id| {
                work.link_metadata_items += 1;
                id.as_str() == from
            }) {
                work.link_copied_bytes += to.len();
                id.clone_from(to);
            }
        }
        let source = output.unwrap_or_else(|| {
            work.materialized_source_bytes += source.len();
            source.to_owned()
        });
        Ok(Self {
            source,
            steps,
            work,
        })
    }

    pub fn selection(
        &self,
        selection: SourceSelection,
        affinity: Affinity,
    ) -> Result<(SourceSelection, usize), EditorError> {
        let SourceSelection::Exact(mut range) = selection else {
            return Ok((SourceSelection::Derived, 0));
        };
        let mut work = 0;
        for step in &self.steps {
            let (start, a) = step.point(range.start, affinity)?;
            let (end, z) = step.point(range.end, affinity)?;
            work += a + z;
            range.start = start;
            range.end = end;
        }
        Ok((SourceSelection::Exact(range), work))
    }
}
impl Step {
    fn point(
        &self,
        mut point: SourcePoint,
        affinity: Affinity,
    ) -> Result<(SourcePoint, usize), EditorError> {
        if point.atom.is_some() {
            let (mapped, work) = self.copied.map(point);
            return Ok((mapped.ok_or(EditorError::UnrepresentableFormat)?, work));
        }
        if point.within != 0 {
            return Err(EditorError::UnrepresentableFormat);
        }
        let (mapped, work) = self.position_with_role(point.source.0, affinity, true)?;
        point.source.0 = mapped;
        Ok((point, work))
    }
    fn position(&self, offset: usize, affinity: Affinity) -> Result<(usize, usize), EditorError> {
        self.position_with_role(offset, affinity, false)
    }
    fn position_with_role(
        &self,
        offset: usize,
        affinity: Affinity,
        caret: bool,
    ) -> Result<(usize, usize), EditorError> {
        if offset > self.input_len {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut work = 1;
        let first = self.replaced.partition_point(|part| {
            work += 1;
            part.range.before.end < offset
        });
        let mapped = if let Some(part) = self.replaced.get(first) {
            work += 4;
            let range = &part.range;
            if offset < range.before.start {
                range.after.start.checked_sub(range.before.start - offset)
            } else if caret && offset <= range.before.end {
                // Canonical emission writes BOTH brackets again. They are not
                // source lineage, but its known target role owns plain-caret
                // edge policy. Nonidentity atoms never enter this branch.
                work += 4;
                if offset < range.before.start + 2 {
                    Some(range.after.start + offset - range.before.start)
                } else if offset > range.before.end - 2 {
                    Some(range.after.end - (range.before.end - offset))
                } else {
                    let (at, visits) = part.caret.map(offset - range.before.start - 2, affinity);
                    work += visits;
                    Some(range.after.start + 2 + at)
                }
            } else if offset == range.before.start {
                Some(range.after.start)
            } else if offset < range.before.end {
                Some(if affinity == Affinity::Forward {
                    range.after.end
                } else {
                    range.after.start
                })
            } else {
                Some(range.after.end)
            }
        } else {
            self.output_len.checked_sub(self.input_len - offset)
        };
        let mapped = mapped
            .filter(|mapped| *mapped <= self.output_len)
            .ok_or(EditorError::UnrepresentableFormat)?;
        Ok((mapped, work))
    }
}
