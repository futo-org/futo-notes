//! Current complete source atoms validate a supplied input origin, never seed it.
use super::*;
use crate::inline::row::{Row, SpanKind};

pub(in crate::inline) fn validate_row(
    raw_len: usize,
    row: &Row,
    origins: &[TypedAngleOrigin],
) -> Result<usize, EditorError> {
    if origins.is_empty() {
        return Ok(0);
    }
    let mut work = 0;
    let mut previous = 0;
    for origin in origins {
        work += 7;
        if origin.opener.is_empty()
            || origin.word.is_empty()
            || origin.opener.end != origin.word.start
            || origin.opener.start < previous
            || origin.word.end > raw_len
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        previous = origin.word.end;
        let first = row.segments.partition_point(|segment| {
            work += 1;
            segment.source.end <= origin.opener.start
        });
        let mut at = origin.opener.start;
        let mut shown = 0;
        let mut prefix = [0u8; 4];
        for segment in &row.segments[first..] {
            work += 1;
            if origin.word.end <= segment.source.start {
                break;
            }
            if segment.source.is_empty() {
                continue;
            }
            if segment.source.start != at || segment.source.end > origin.word.end {
                return Err(EditorError::UnrepresentableFormat);
            }
            at = segment.source.end;
            let text = &row.display[segment.display.clone()];
            if segment.source == origin.opener {
                work += 1;
                if text != "<" {
                    return Err(EditorError::UnrepresentableFormat);
                }
            } else {
                work += 2;
                if segment.source.start < origin.word.start || text.is_empty() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                for ch in text.chars() {
                    work += 1;
                    // The producer owns terminal closer syntax. A canonical
                    // URI may include a nonterminal angle scalar as word data.
                    if ch.is_whitespace() {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                }
                if let Some(uri) = &origin.uri {
                    let Some(expected) = uri.displayed.get(shown..shown + text.len()) else {
                        return Err(EditorError::UnrepresentableFormat);
                    };
                    if !text.bytes().zip(expected.bytes()).all(|(a, b)| {
                        work += 1;
                        a == b
                    }) {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                }
                for (index, byte) in text.bytes().enumerate().take(4usize.saturating_sub(shown)) {
                    prefix[shown + index] = byte;
                    work += 1;
                }
                shown += text.len();
            }
        }
        if at != origin.word.end
            || origin.uri.as_ref().is_some_and(|uri| {
                work += 1;
                uri.displayed.len() != shown
            })
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        work += 1;
        if !(shown <= 3 && &prefix[..shown] == &b"www"[..shown] || shown >= 4 && prefix == *b"www.")
        {
            return Err(EditorError::UnrepresentableFormat);
        }
    }
    for span in &row.spans {
        work += 1;
        if !matches!(
            span.kind,
            SpanKind::Link(_) | SpanKind::Format(crate::InlineFormat::Code)
        ) {
            continue;
        }
        let first = origins.partition_point(|origin| {
            work += 1;
            origin.word.end <= span.open.start
        });
        if origins.get(first).is_some_and(|origin| {
            work += 1;
            origin.opener.start < span.close.end
        }) {
            return Err(EditorError::UnrepresentableFormat);
        }
    }
    for block in &row.blocks {
        work += 1;
        if !block.code {
            continue;
        }
        let first = origins.partition_point(|origin| {
            work += 1;
            origin.word.end <= block.source.start
        });
        if origins.get(first).is_some_and(|origin| {
            work += 1;
            origin.opener.start < block.source.end
        }) {
            return Err(EditorError::UnrepresentableFormat);
        }
    }
    Ok(work)
}
