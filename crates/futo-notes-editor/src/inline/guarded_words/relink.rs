//! Canonical eligibility of a command-transformed, already-owned URI with retained Code markers.
use super::*;
use crate::inline::{row::SpanKind, Projection};
use crate::{EditWork, InlineFormat};

pub(crate) struct CanonicalUri {
    pub displayed: String,
    pub meaning: Arc<LinkMeaning>,
}
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct CodeWitness {
    pub open: Range<usize>,
    pub close: Range<usize>,
}
impl Projection {
    /// One ordered owner index assigns each real canonical Code span once.
    fn relink_code_witnesses(
        &self,
        words: &[GuardedWord],
        origin: usize,
    ) -> Result<(Vec<Vec<CodeWitness>>, usize), EditorError> {
        let mut result = vec![Vec::new(); words.len()];
        let mut work = usize::from(!words.is_empty()) + words.len();
        let mut first = 0;
        while first < words.len() {
            let at = words[first]
                .inner
                .start
                .checked_sub(origin)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let (row, base, _, visits) = self.rows.source_row_with_work(at);
            work += visits;
            let base = origin + base;
            let last = words.partition_point(|word| {
                work += 1;
                word.inner.start < base + row.source_len
            });
            if last <= first || words[last - 1].inner.end > base + row.source_len {
                return Err(EditorError::UnrepresentableFormat);
            }
            for span in &row.spans {
                work += 1;
                if !matches!(span.kind, SpanKind::Format(InlineFormat::Code)) {
                    continue;
                }
                let start = base + span.open.start;
                let end = base + span.close.end;
                let local = words[first..last].partition_point(|word| {
                    work += 1;
                    word.inner.end <= start
                });
                let index = first + local;
                let Some(word) = words.get(index).filter(|_| index < last) else {
                    continue;
                };
                work += 3;
                if end <= word.inner.start {
                    continue;
                }
                if start < word.inner.start || word.inner.end < end {
                    return Err(EditorError::UnrepresentableFormat);
                }
                result[index].push(CodeWitness {
                    open: start..base + span.open.end,
                    close: base + span.close.start..end,
                });
                work += 5;
            }
            first = last;
        }
        Ok((result, work))
    }

    /// Requests are source-ordered and refer to this exact staged generation.
    /// One row span index serves every owned word; no final text search.
    pub(crate) fn relink_code_uris(
        &self,
        words: &[GuardedWord],
        origin: usize,
        expected: Option<&[Vec<CodeWitness>]>,
    ) -> Result<(Vec<CanonicalUri>, Vec<Vec<CodeWitness>>, EditWork), EditorError> {
        let mut work = EditWork::default();
        let (codes, visits) = self.relink_code_witnesses(words, origin)?;
        work.link_metadata_items += visits;
        if let Some(expected) = expected {
            if expected.len() != codes.len() {
                return Err(EditorError::UnrepresentableFormat);
            }
            for (old, current) in expected.iter().zip(&codes) {
                work.link_metadata_items += 1 + 4 * old.len().min(current.len());
                if old != current {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
        }
        let mut result = Vec::with_capacity(words.len());
        work.link_metadata_items += usize::from(!words.is_empty());
        let mut first = 0;
        while first < words.len() {
            let start = words[first]
                .inner
                .start
                .checked_sub(origin)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let (row, base, _, visits) = self.rows.source_row_with_work(start);
            work.link_metadata_items += visits;
            while let Some(word) = words.get(first) {
                work.link_metadata_items += 1;
                let a = word
                    .inner
                    .start
                    .checked_sub(origin + base)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                if a >= row.source_len {
                    break;
                }
                let z = word
                    .inner
                    .end
                    .checked_sub(origin + base)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                work.link_metadata_items += 3;
                if z > row.source_len {
                    return Err(EditorError::UnrepresentableFormat);
                }
                let segment = row.segments.partition_point(|part| {
                    work.link_metadata_items += 1;
                    part.source.end <= a
                });
                let mut at = a;
                let mut displayed = String::new();
                for part in &row.segments[segment..] {
                    work.link_metadata_items += 1;
                    if at == z {
                        break;
                    }
                    if part.source.is_empty() {
                        continue;
                    }
                    if part.source.start != at || part.source.end > z {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    let text = &row.display[part.display.clone()];
                    displayed.push_str(text);
                    work.link_copied_bytes += text.len();
                    work.link_metadata_items += 3;
                    at = part.source.end;
                }
                if at != z {
                    return Err(EditorError::UnrepresentableFormat);
                }
                let (canonical, parsed) = crate::inline::links::bare_links(&displayed);
                work.parsed_source_bytes += parsed;
                work.link_metadata_items += 1 + canonical.len();
                let Some(span) = canonical.first().filter(|span| {
                    canonical.len() == 1
                        && span.open.start == 0
                        && span.close.end == displayed.len()
                }) else {
                    return Err(EditorError::UnrepresentableFormat);
                };
                let SpanKind::Link(meaning) = &span.kind else {
                    return Err(EditorError::UnrepresentableFormat);
                };
                if meaning.title.is_some() || meaning.reference.is_some() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                work.link_copied_bytes += meaning.destination.len();
                result.push(CanonicalUri {
                    displayed,
                    meaning: meaning.clone(),
                });
                work.link_metadata_items += 4;
                first += 1;
            }
        }
        Ok((result, codes, work))
    }
}
