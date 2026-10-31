//! Canonical eligibility of a command-transformed, already-owned URI with retained Code markers.
use super::*;
use crate::inline::{row::SpanKind, Projection};
use crate::{EditWork, InlineFormat};

pub(crate) struct CanonicalUri {
    pub displayed: String,
    pub meaning: Arc<LinkMeaning>,
}
pub(crate) enum RelinkWord {
    Uri(CanonicalUri),
    Literal(String),
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
        words: &[Range<usize>],
        origin: usize,
    ) -> Result<(Vec<Vec<CodeWitness>>, usize), EditorError> {
        let mut result = vec![Vec::new(); words.len()];
        let mut work = usize::from(!words.is_empty()) + words.len();
        let mut first = 0;
        while first < words.len() {
            let at = words[first]
                .start
                .checked_sub(origin)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let (row, base, _, visits) = self.rows.source_row_with_work(at);
            work += visits;
            let base = origin + base;
            let last = words.partition_point(|word| {
                work += 1;
                word.start < base + row.source_len
            });
            if last <= first || words[last - 1].end > base + row.source_len {
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
                    word.end <= start
                });
                let index = first + local;
                let Some(word) = words.get(index).filter(|_| index < last) else {
                    continue;
                };
                work += 3;
                if end <= word.start {
                    continue;
                }
                if start < word.start || word.end < end {
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
    pub(crate) fn relink_owned_uris(
        &self,
        words: &[Range<usize>],
        origin: usize,
        expected: Option<&[Vec<CodeWitness>]>,
    ) -> Result<(Vec<RelinkWord>, Vec<Vec<CodeWitness>>, EditWork), EditorError> {
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
                .start
                .checked_sub(origin)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let (row, base, _, visits) = self.rows.source_row_with_work(start);
            work.link_metadata_items += visits;
            while let Some(word) = words.get(first) {
                work.link_metadata_items += 1;
                let a = word
                    .start
                    .checked_sub(origin + base)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                if a >= row.source_len {
                    break;
                }
                let z = word
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
                let (canonical, read) = crate::inline::links::bare_links(&displayed);
                work.link_metadata_items += read.items;
                work.parsed_source_bytes += read.parsed;
                work.link_copied_bytes += read.copied;
                work.link_metadata_items += 1 + canonical.len();
                let Some(span) = canonical.first().filter(|span| {
                    canonical.len() == 1
                        && span.open.start == 0
                        && span.close.end == displayed.len()
                }) else {
                    // None is no COMPLETE URI, and may contain a partial
                    // canonical link. It is not a word-end retirement policy.
                    result.push(RelinkWord::Literal(displayed));
                    work.link_metadata_items += 1;
                    first += 1;
                    continue;
                };
                let SpanKind::Link(meaning) = &span.kind else {
                    return Err(EditorError::UnrepresentableFormat);
                };
                if meaning.title.is_some() || meaning.reference.is_some() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                result.push(RelinkWord::Uri(CanonicalUri {
                    displayed,
                    meaning: meaning.clone(),
                }));
                work.link_metadata_items += 4;
                first += 1;
            }
        }
        Ok((result, codes, work))
    }
}

impl Projection {
    /// One actual row span walk excludes Links from every retired envelope.
    /// Code pairing is independently checked by relink_owned_uris.
    pub(crate) fn validate_literal_relink_envelopes(
        &self,
        envelopes: &[Range<usize>],
        origin: usize,
    ) -> Result<usize, EditorError> {
        let mut work = 0;
        let mut first = 0;
        while first < envelopes.len() {
            let at = envelopes[first]
                .start
                .checked_sub(origin)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let (row, base, _, visits) = self.rows.source_row_with_work(at);
            work += visits;
            let base = origin + base;
            let last = envelopes.partition_point(|range| {
                work += 1;
                range.start < base + row.source_len
            });
            if last <= first || envelopes[last - 1].end > base + row.source_len {
                return Err(EditorError::UnrepresentableFormat);
            }
            for span in &row.spans {
                work += 1;
                if !matches!(span.kind, SpanKind::Link(_)) {
                    continue;
                }
                let start = base + span.open.start;
                let end = base + span.close.end;
                let index = first
                    + envelopes[first..last].partition_point(|range| {
                        work += 1;
                        range.end <= start
                    });
                if index < last && envelopes[index].start < end {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            first = last;
        }
        Ok(work)
    }
}
