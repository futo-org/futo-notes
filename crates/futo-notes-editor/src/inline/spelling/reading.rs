//! Judge how the parser read a rendered candidate against the intended spans.
use super::{render::Rendered, Row, Span, SpanKind};

/// Whether `read` is `typed` with some inline delimiters turned into hidden
/// markers and nothing else changed.
pub(super) fn only_delimiters_hidden(typed: &str, read: &str) -> bool {
    let mut read = read.chars().peekable();
    for ch in typed.chars() {
        if read.peek() == Some(&ch) {
            read.next();
        } else if !matches!(ch, '*' | '_' | '~' | '`') {
            return false;
        }
    }
    read.next().is_none()
}

/// Whether every rendered span's visible content is still inside a candidate
/// span of the same kind, however the parser now pairs the markers.
pub(super) fn spans_still_cover(rendered: &Rendered, candidate: &Row, work: &mut usize) -> bool {
    let inner = |span: &Span| {
        (
            candidate.display_at(span.open.end),
            candidate.display_at(span.close.start),
        )
    };
    let found: Vec<_> = candidate
        .spans
        .iter()
        .map(|span| (&span.kind, inner(span)))
        .collect();
    rendered.spans.iter().all(|(_, span)| {
        let (start, end) = inner(span);
        start >= end
            || found.iter().any(|(kind, (a, z))| {
                *work += 1;
                **kind == span.kind && *a <= start && end <= *z
            })
    })
}

/// Rendered span ids the candidate parse does not reproduce with the same
/// kind and marker ranges, in rendered order. Candidate spans are indexed by
/// their marker ranges, so a row of many links costs spans, not their product.
/// `work` counts each candidate span indexed and each rendered span checked.
pub(super) fn missing_spans(rendered: &Rendered, candidate: &Row, work: &mut usize) -> Vec<usize> {
    *work += candidate.spans.len() + rendered.spans.len();
    let mut found: std::collections::HashMap<_, Vec<&SpanKind>> =
        std::collections::HashMap::with_capacity(candidate.spans.len());
    for span in &candidate.spans {
        found
            .entry((
                span.open.start,
                span.open.end,
                span.close.start,
                span.close.end,
            ))
            .or_default()
            .push(&span.kind);
    }
    rendered
        .spans
        .iter()
        .filter(|(_, expected)| {
            !found
                .get(&(
                    expected.open.start,
                    expected.open.end,
                    expected.close.start,
                    expected.close.end,
                ))
                .is_some_and(|kinds| kinds.iter().any(|kind| **kind == expected.kind))
        })
        .map(|(id, _)| *id)
        .collect()
}
