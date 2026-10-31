//! Validate supplied identities against complete current canonical atoms.
use super::*;
use crate::inline::row::{Row, SpanKind};

/// The caller supplies this row's actual raw source and row-local fields.
/// Equality verifies an existing owner; it never finds or creates ownership.
pub(crate) fn validate_row(
    raw: &str,
    row: &Row,
    words: &[GuardedWord],
) -> Result<usize, EditorError> {
    if words.is_empty() {
        return Ok(0);
    }
    let mut work = 0;
    let mut markers = Vec::new();
    for span in &row.spans {
        work += 1;
        if matches!(span.kind, SpanKind::Format(_)) {
            work += 4;
            markers.extend([span.open.clone(), span.close.clone()]);
        }
    }
    markers.sort_unstable_by(|a, b| {
        work += 1;
        (a.start, a.end).cmp(&(b.start, b.end))
    });
    let mut previous = 0;
    let mut identities = std::collections::HashSet::with_capacity(words.len());
    work += 1;
    for word in words {
        work += 8;
        if word.envelope.start < previous
            || word.envelope.start >= word.inner.start
            || word.inner.start >= word.inner.end
            || word.inner.end >= word.envelope.end
            || word.envelope.end > raw.len()
            || !identities.insert(Arc::as_ptr(&word.identity))
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        previous = word.envelope.end;
        let first = row.segments.partition_point(|segment| {
            work += 1;
            segment.source.end <= word.envelope.start
        });
        let mut source = word.envelope.start;
        let mut displayed = 0;
        for segment in &row.segments[first..] {
            work += 1;
            if word.envelope.end <= segment.source.start {
                break;
            }
            if segment.source.is_empty() {
                continue;
            }
            if segment.source.start != source || segment.source.end > word.envelope.end {
                return Err(EditorError::UnrepresentableFormat);
            }
            source = segment.source.end;
            let text = &row.display[segment.display.clone()];
            work += 3;
            if segment.source == (word.envelope.start..word.inner.start) {
                if text != "<" {
                    return Err(EditorError::UnrepresentableFormat);
                }
            } else if segment.source == (word.inner.end..word.envelope.end) {
                if text != ">" {
                    return Err(EditorError::UnrepresentableFormat);
                }
            } else if word.inner.start <= segment.source.start
                && segment.source.end <= word.inner.end
            {
                if text.is_empty() {
                    if markers
                        .binary_search_by(|range| {
                            work += 1;
                            (range.start, range.end)
                                .cmp(&(segment.source.start, segment.source.end))
                        })
                        .is_err()
                    {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                } else {
                    let Some(expected) = word
                        .identity
                        .displayed
                        .get(displayed..displayed + text.len())
                    else {
                        return Err(EditorError::UnrepresentableFormat);
                    };
                    if !text.bytes().zip(expected.bytes()).all(|(a, b)| {
                        work += 1;
                        a == b
                    }) {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    displayed += text.len();
                }
            } else {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        if source != word.envelope.end || displayed != word.identity.displayed.len() {
            return Err(EditorError::UnrepresentableFormat);
        }
    }
    // Canonical links cannot overlap an opaque word. One ordered field index
    // serves all spans; inline marker bodies do not authorize hidden prefixes.
    for span in &row.spans {
        work += 1;
        if !matches!(span.kind, SpanKind::Link(_)) {
            continue;
        }
        let first = words.partition_point(|word| {
            work += 1;
            word.envelope.end <= span.open.start
        });
        if words.get(first).is_some_and(|word| {
            work += 1;
            word.envelope.start < span.close.end
        }) {
            return Err(EditorError::UnrepresentableFormat);
        }
    }
    Ok(work)
}
