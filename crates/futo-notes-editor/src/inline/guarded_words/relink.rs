//! Canonical eligibility of a command-transformed, already-owned whole Code URI.
use super::*;
use crate::inline::{row::SpanKind, Projection};
use crate::{EditWork, InlineFormat};

pub(crate) struct CanonicalUri {
    pub displayed: String,
    pub meaning: Arc<LinkMeaning>,
}
impl Projection {
    /// Requests are source-ordered and refer to this exact staged generation.
    /// One row span index serves every owned word; no final text search.
    pub(crate) fn relink_code_uris(
        &self,
        words: &[GuardedWord],
        origin: usize,
    ) -> Result<(Vec<CanonicalUri>, EditWork), EditorError> {
        let mut work = EditWork::default();
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
            let mut codes = std::collections::HashSet::new();
            for span in &row.spans {
                work.link_metadata_items += 1;
                if matches!(span.kind, SpanKind::Format(InlineFormat::Code)) {
                    codes.insert((span.open.start, span.close.end));
                    work.link_metadata_items += 2;
                }
            }
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
                if z > row.source_len || !codes.contains(&(a, z)) {
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
        Ok((result, work))
    }
}
