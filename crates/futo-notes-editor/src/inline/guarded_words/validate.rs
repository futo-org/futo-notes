//! Validate supplied identities against complete current canonical atoms.
use super::*;
use crate::inline::row::{Row, SpanKind};

pub(in crate::inline) struct LiteralRetirement<'a> {
    pub envelope: Range<usize>,
    pub inner: Range<usize>,
    pub displayed: &'a str,
}
struct Field<'a> {
    envelope: &'a Range<usize>,
    inner: &'a Range<usize>,
    displayed: &'a str,
    identity: Option<*const CodeWordIdentity>,
}

/// The caller supplies this row's actual raw source and row-local fields.
/// Equality verifies an existing owner; it never finds or creates ownership.
pub(crate) fn validate_row(
    raw: &str,
    row: &Row,
    words: &[GuardedWord],
) -> Result<usize, EditorError> {
    validate_with_retirement(raw, row, words, None)
}

pub(in crate::inline) fn validate_with_retirement(
    raw: &str,
    row: &Row,
    words: &[GuardedWord],
    retired: Option<&LiteralRetirement<'_>>,
) -> Result<usize, EditorError> {
    if words.is_empty() && retired.is_none() {
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
    let mut live = words.iter().peekable();
    let mut pending_retired = retired;
    while live.peek().is_some() || pending_retired.is_some() {
        let retired_first = pending_retired.is_some_and(|field| {
            work += 1;
            live.peek().is_none_or(|word| {
                work += 1;
                field.envelope.start < word.envelope.start
            })
        });
        let field = if retired_first {
            let retired = pending_retired.take().unwrap();
            Field {
                envelope: &retired.envelope,
                inner: &retired.inner,
                displayed: retired.displayed,
                identity: None,
            }
        } else {
            let word = live.next().unwrap();
            Field {
                envelope: &word.envelope,
                inner: &word.inner,
                displayed: &word.identity.displayed,
                identity: Some(Arc::as_ptr(&word.identity)),
            }
        };
        work += 8;
        if field.envelope.start < previous
            || field.envelope.start >= field.inner.start
            || field.inner.start > field.inner.end
            || field.identity.is_some() && field.inner.is_empty()
            || field.inner.end >= field.envelope.end
            || field.envelope.end > raw.len()
            || field
                .identity
                .is_some_and(|identity| !identities.insert(identity))
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        previous = field.envelope.end;
        let first = row.segments.partition_point(|segment| {
            work += 1;
            segment.source.end <= field.envelope.start
        });
        let mut source = field.envelope.start;
        let mut displayed = 0;
        for segment in &row.segments[first..] {
            work += 1;
            if field.envelope.end <= segment.source.start {
                break;
            }
            if segment.source.is_empty() {
                continue;
            }
            if segment.source.start != source || segment.source.end > field.envelope.end {
                return Err(EditorError::UnrepresentableFormat);
            }
            source = segment.source.end;
            let text = &row.display[segment.display.clone()];
            work += 3;
            if segment.source == (field.envelope.start..field.inner.start) {
                if text != "<" {
                    return Err(EditorError::UnrepresentableFormat);
                }
            } else if segment.source == (field.inner.end..field.envelope.end) {
                if text != ">" {
                    return Err(EditorError::UnrepresentableFormat);
                }
            } else if field.inner.start <= segment.source.start
                && segment.source.end <= field.inner.end
            {
                if text.is_empty() {
                    let marker = markers.partition_point(|range| {
                        work += 1;
                        range.end <= segment.source.start
                    });
                    if !markers.get(marker).is_some_and(|range| {
                        work += 4;
                        field.inner.start <= range.start
                            && range.end <= field.inner.end
                            && range.start <= segment.source.start
                            && segment.source.end <= range.end
                    }) {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                } else {
                    let Some(expected) = field.displayed.get(displayed..displayed + text.len())
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
        if source != field.envelope.end || displayed != field.displayed.len() {
            return Err(EditorError::UnrepresentableFormat);
        }
    }
    // One source-ordered live-field index and at most one retired view serve
    // every canonical span. Retirement never manufactures a URI identity.
    for span in &row.spans {
        work += 1;
        if matches!(span.kind, SpanKind::Link(_)) {
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
        if let Some(retired) = retired {
            work += 1;
            if matches!(
                span.kind,
                SpanKind::Link(_) | SpanKind::Format(crate::InlineFormat::Code)
            ) {
                work += 2;
                if span.open.start < retired.envelope.end && retired.envelope.start < span.close.end
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
        }
    }
    Ok(work)
}
