//! The actual final Spelling step is distinct from canonical wiki emission.
use super::*;
use crate::inline::{RetainedFormat, RetiredLinkText};
use std::ops::Range;

struct Region {
    before: PendingLinkWitness,
    after: Range<usize>,
    text: String,
    formats: Vec<RetainedFormat>,
}
pub(super) struct SpellingStep {
    copied: SourceCorrespondence,
    anchors: Vec<(SourcePoint, SourcePoint)>,
    regions: Vec<Region>,
}
impl SpellingStep {
    pub(super) fn point(&self, point: SourcePoint) -> Result<(SourcePoint, usize), EditorError> {
        let (copied, mut work) = self.copied.map(point);
        if let Some(point) = copied {
            return Ok((point, work));
        }
        if point.atom.is_some() || point.within != 0 {
            return Err(EditorError::UnrepresentableFormat);
        }
        let index = self.anchors.partition_point(|(before, _)| {
            work += 1;
            before.source.0 < point.source.0
        });
        let (before, after) = self
            .anchors
            .get(index)
            .ok_or(EditorError::UnrepresentableFormat)?;
        work += 1;
        if *before != point {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok((*after, work))
    }
    fn range(&self, range: Range<usize>, work: &mut usize) -> Result<Range<usize>, EditorError> {
        let (mapped, visits) = self.copied.retained_range(range);
        *work += visits;
        mapped.ok_or(EditorError::UnrepresentableFormat)
    }
    fn retired(&self, body: &Range<usize>, work: &mut usize) -> bool {
        self.regions
            .binary_search_by(|r| {
                *work += 1;
                (r.before.body.start, r.before.body.end).cmp(&(body.start, body.end))
            })
            .is_ok()
    }
    pub(super) fn fields(&self, fields: &mut Fields) -> Result<usize, EditorError> {
        let mut work = 0;
        for endpoint in [
            &mut fields.pending.window.start,
            &mut fields.pending.window.end,
        ] {
            let (point, visits) = self.point(SourcePoint {
                source: SourceOffset(*endpoint),
                within: 0,
                atom: None,
            })?;
            *endpoint = point.source.0;
            work += visits;
        }
        let mut ranges = Vec::new();
        for range in std::mem::take(&mut fields.pending.ranges) {
            work += 1;
            if !self.retired(&range, &mut work) {
                ranges.push(self.range(range, &mut work)?);
            }
        }
        fields.pending.ranges = ranges;
        for range in &mut fields.pending.delimiters {
            *range = self.range(range.clone(), &mut work)?;
        }
        for word in &mut fields.pending.guarded_words {
            word.envelope = self.range(word.envelope.clone(), &mut work)?;
            word.inner = self.range(word.inner.clone(), &mut work)?;
            work += 4;
        }
        for word in &mut fields.pending.typed_inputs {
            word.opener = self.range(word.opener.clone(), &mut work)?;
            word.word = self.range(word.word.clone(), &mut work)?;
            work += 4;
        }
        for owner in &mut fields.codes {
            for code in owner {
                code.open = self.range(code.open.clone(), &mut work)?;
                code.close = self.range(code.close.clone(), &mut work)?;
            }
        }
        let old = std::mem::take(&mut fields.original_witnesses);
        let witnesses = std::mem::take(&mut fields.witnesses);
        let changed = std::mem::take(&mut fields.changed_links);
        for ((original, mut witness), changed) in old.into_iter().zip(witnesses).zip(changed) {
            work += 1;
            if self.retired(&witness.body, &mut work) {
                continue;
            }
            witness.open = self.range(witness.open, &mut work)?;
            witness.body = self.range(witness.body, &mut work)?;
            witness.close = self.range(witness.close, &mut work)?;
            fields.original_witnesses.push(original);
            fields.witnesses.push(witness);
            fields.changed_links.push(changed);
            work += 8;
        }
        Ok(work)
    }
}
impl Rewrite {
    fn core_copy(
        &self,
        mut range: Range<usize>,
        work: &mut EditWork,
    ) -> Result<Range<usize>, EditorError> {
        for step in &self.steps {
            range = fields::copied(step, range, &mut work.link_metadata_items)?;
        }
        Ok(range)
    }
    /// All scopes at this source boundary choose one source before suppression.
    pub(in crate::session::relink) fn spell_pending_literals(
        &mut self,
        original: &EditorSession,
        fields: &mut [Fields],
        points: &[SourcePoint],
    ) -> Result<EditWork, EditorError> {
        let mut work = EditWork::default();
        let mut union: Vec<(PendingLinkWitness, PendingLinkWitness)> = Vec::new();
        for scope in fields.iter() {
            for ((before, after), changed) in scope
                .original_witnesses
                .iter()
                .zip(&scope.witnesses)
                .zip(&scope.changed_links)
            {
                work.link_metadata_items += 1;
                if !changed {
                    continue;
                }
                union.push((before.clone(), after.clone()));
                work.link_metadata_items += 14;
            }
        }
        union.sort_unstable_by(|a, b| {
            work.link_metadata_items += 1;
            a.0.body.start.cmp(&b.0.body.start)
        });
        let mut unique: Vec<(PendingLinkWitness, PendingLinkWitness)> = Vec::new();
        for (before, after) in union {
            if let Some((old, mapped)) = unique.last() {
                if old.body == before.body {
                    work.link_metadata_items += 9;
                    if old.open != before.open
                        || old.close != before.close
                        || old.meaning != before.meaning
                        || mapped.open != after.open
                        || mapped.body != after.body
                        || mapped.close != after.close
                    {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    continue;
                }
            }
            unique.push((before, after));
        }
        let mut candidates = Vec::new();
        for (before, after) in unique {
            let label = self
                .source
                .get(after.body.clone())
                .ok_or(EditorError::UnrepresentableFormat)?;
            let (complete, read) = crate::inline::complete_bare_uri(label);
            charge(&mut work, read);
            if complete {
                continue;
            }
            // A whole scope that explicitly owns this witness must agree on
            // pending authority; absence merely outside a scope is irrelevant.
            for scope in fields.iter() {
                work.link_metadata_items += 1;
                if scope.pending.window.start <= after.open.start
                    && after.close.end <= scope.pending.window.end
                    && !scope.pending.ranges.contains(&after.body)
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            candidates.push((before, after));
        }
        if candidates.is_empty() {
            return Ok(work);
        }
        let mut required = points.to_vec();
        for scope in fields.iter() {
            for at in [scope.pending.window.start, scope.pending.window.end] {
                required.push(SourcePoint {
                    source: SourceOffset(at),
                    within: 0,
                    atom: None,
                });
            }
        }
        required.sort_unstable_by(|a, b| {
            work.link_metadata_items += 1;
            a.source.0.cmp(&b.source.0)
        });
        required.dedup();
        let mut output = String::new();
        let mut copies = Vec::new();
        let mut anchors = Vec::new();
        let mut regions = Vec::new();
        let mut cursor = 0;
        for (before, after) in candidates {
            let envelope = after.open.start..after.close.end;
            if envelope.start < cursor {
                return Err(EditorError::UnrepresentableFormat);
            }
            let prefix = self
                .source
                .get(cursor..envelope.start)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let prefix_start = output.len();
            output.push_str(prefix);
            copies.push(RetainedBody {
                before: cursor..envelope.start,
                after: prefix_start..output.len(),
            });
            let label = self
                .source
                .get(after.body.clone())
                .ok_or(EditorError::UnrepresentableFormat)?;
            let first = required.partition_point(|point| {
                work.link_metadata_items += 1;
                point.source.0 < envelope.start
            });
            let last = required.partition_point(|point| {
                work.link_metadata_items += 1;
                point.source.0 <= envelope.end
            });
            let mut semantic = Vec::new();
            for point in &required[first..last] {
                work.link_metadata_items += 1;
                if point.atom.is_some() || point.within != 0 {
                    return Err(EditorError::UnrepresentableFormat);
                }
                let offset = if point.source.0 <= after.body.start {
                    0
                } else if point.source.0 >= after.body.end {
                    label.len()
                } else {
                    point.source.0 - after.body.start
                };
                if !label.is_char_boundary(offset) {
                    return Err(EditorError::UnrepresentableFormat);
                }
                semantic.push(offset);
            }
            let RetiredLinkText {
                text,
                copied,
                anchors: mapped,
                mut formats,
                work: spelling_work,
            } = original.projection.spell_relinked_pending_uri(
                &original.source,
                &before,
                label,
                &semantic,
            )?;
            charge(&mut work, spelling_work);
            let start = output.len();
            output.push_str(&text);
            for body in copied {
                copies.push(RetainedBody {
                    before: after.body.start + body.before.start
                        ..after.body.start + body.before.end,
                    after: start + body.after.start..start + body.after.end,
                });
                work.link_metadata_items += 4;
            }
            for (point, offset) in required[first..last].iter().zip(mapped) {
                anchors.push((
                    *point,
                    SourcePoint {
                        source: SourceOffset(start + offset),
                        within: 0,
                        atom: None,
                    },
                ));
                work.link_metadata_items += 4;
            }
            for format in &mut formats {
                format.open = self.core_copy(format.open.clone(), &mut work)?;
                format.close = self.core_copy(format.close.clone(), &mut work)?;
            }
            regions.push(Region {
                before: after,
                after: start..output.len(),
                text: label.to_owned(),
                formats,
            });
            work.link_copied_bytes += label.len();
            cursor = envelope.end;
        }
        let start = output.len();
        output.push_str(
            self.source
                .get(cursor..)
                .ok_or(EditorError::UnrepresentableFormat)?,
        );
        copies.push(RetainedBody {
            before: cursor..self.source.len(),
            after: start..output.len(),
        });
        work.materialized_source_bytes += output.len();
        let (copied, visits) = SourceCorrespondence::from_bodies(&copies)?;
        work.link_metadata_items += visits;
        for region in &mut regions {
            for format in &mut region.formats {
                let (open, a) = copied.retained_range(format.open.clone());
                let (close, z) = copied.retained_range(format.close.clone());
                work.link_metadata_items += a + z;
                format.open = open.ok_or(EditorError::UnrepresentableFormat)?;
                format.close = close.ok_or(EditorError::UnrepresentableFormat)?;
            }
        }
        let step = SpellingStep {
            copied,
            anchors,
            regions,
        };
        for field in fields {
            work.link_metadata_items += step.fields(field)?;
        }
        self.source = output;
        self.spelling = Some(step);
        Ok(work)
    }
    pub(in crate::session::relink) fn has_spelling(&self) -> bool {
        self.spelling.is_some()
    }
    pub(in crate::session::relink) fn spelling_point(
        &self,
        point: SourcePoint,
    ) -> Result<(SourcePoint, usize), EditorError> {
        self.spelling
            .as_ref()
            .map_or(Ok((point, 0)), |step| step.point(point))
    }
    pub(in crate::session::relink) fn validate_spelling(
        &self,
        candidate: &EditorSession,
        origin: usize,
    ) -> Result<usize, EditorError> {
        let Some(step) = &self.spelling else {
            return Ok(0);
        };
        let proofs: Vec<_> = step
            .regions
            .iter()
            .map(|r| (&r.after, r.text.as_str(), r.formats.as_slice()))
            .collect();
        candidate
            .projection
            .validate_retired_link_texts(&proofs, origin)
    }
}
