//! Complete canonical marker proof for body-only pending URL fields.
use super::*;
use crate::inline::row::LinkMeaning;
use crate::EditorError;
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct PendingLinkWitness {
    pub body: Range<usize>,
    pub open: Range<usize>,
    pub close: Range<usize>,
    pub meaning: Arc<LinkMeaning>,
}
impl Projection {
    pub(crate) fn pending_link_witnesses(
        &self,
        ranges: &[Range<usize>],
    ) -> Result<(Vec<PendingLinkWitness>, usize), EditorError> {
        if ranges.is_empty() {
            return Ok((Vec::new(), 0));
        }
        let mut work = 1 + 2 * ranges.len();
        let mut wanted = ranges.to_vec();
        wanted.sort_unstable_by(|a, b| {
            work += 1;
            (a.start, a.end).cmp(&(b.start, b.end))
        });
        for (i, range) in wanted.iter().enumerate() {
            work += 1;
            if range.start >= range.end || i > 0 && wanted[i - 1].end > range.start {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        let mut seen = vec![false; wanted.len()];
        let mut result = Vec::with_capacity(wanted.len());
        work += 2 + seen.len();
        let mut first = 0;
        while first < wanted.len() {
            let (row, base, _, visits) = self.rows.source_row_with_work(wanted[first].start);
            work += visits;
            let last = wanted.partition_point(|range| {
                work += 1;
                range.start < base + row.source_len
            });
            if last <= first || wanted[last - 1].end > base + row.source_len {
                return Err(EditorError::UnrepresentableFormat);
            }
            for span in &row.spans {
                work += 1;
                if !pending_span(span) {
                    continue;
                }
                let body = base + span.open.end..base + span.close.start;
                let Ok(local) = wanted[first..last].binary_search_by(|range| {
                    work += 1;
                    (range.start, range.end).cmp(&(body.start, body.end))
                }) else {
                    continue;
                };
                let index = first + local;
                if seen[index] {
                    return Err(EditorError::UnrepresentableFormat);
                }
                let SpanKind::Link(meaning) = &span.kind else {
                    unreachable!()
                };
                work += 8;
                result.push(PendingLinkWitness {
                    body,
                    open: base + span.open.start..base + span.open.end,
                    close: base + span.close.start..base + span.close.end,
                    meaning: meaning.clone(),
                });
                seen[index] = true;
            }
            first = last;
        }
        for found in seen {
            work += 1;
            if !found {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        result.sort_unstable_by(|a, b| {
            work += 1;
            (a.body.start, a.body.end).cmp(&(b.body.start, b.body.end))
        });
        Ok((result, work))
    }

    pub(crate) fn verify_pending_link_witnesses(
        &self,
        expected: &[PendingLinkWitness],
        base: usize,
    ) -> Result<usize, EditorError> {
        if expected.is_empty() {
            return Ok(0);
        }
        let mut work = 1;
        let mut bodies = Vec::with_capacity(expected.len());
        for field in expected {
            let a = field
                .body
                .start
                .checked_sub(base)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let z = field
                .body
                .end
                .checked_sub(base)
                .ok_or(EditorError::UnrepresentableFormat)?;
            work += 2;
            bodies.push(a..z);
        }
        let (actual, visits) = self.pending_link_witnesses(&bodies)?;
        work += visits;
        if actual.len() != expected.len() {
            return Err(EditorError::UnrepresentableFormat);
        }
        for (old, new) in expected.iter().zip(&actual) {
            work += 9;
            if old.body != (base + new.body.start..base + new.body.end)
                || old.open != (base + new.open.start..base + new.open.end)
                || old.close != (base + new.close.start..base + new.close.end)
                || old.meaning.title != new.meaning.title
                || old.meaning.reference != new.meaning.reference
                || old.meaning.destination.len() != new.meaning.destination.len()
                || !old
                    .meaning
                    .destination
                    .bytes()
                    .zip(new.meaning.destination.bytes())
                    .all(|(a, b)| {
                        work += 1;
                        a == b
                    })
            {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(work)
    }
}
