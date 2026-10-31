//! Ephemeral plain atoms for the two transformed Typed URI-class branches.
use super::*;
use crate::inline::{row::SpanKind, Projection};

impl Projection {
    /// Eligibility is intentionally narrower than the ordinary Typed validator:
    /// no hidden/normalized atom or marker may supply this retirement proof.
    pub(crate) fn plain_relink_typed(
        &self,
        input: &TypedAngleOrigin,
        expected: &str,
        origin: usize,
    ) -> (bool, usize) {
        let mut work = 2;
        let Some(start) = input.opener.start.checked_sub(origin) else {
            return (false, work);
        };
        let Some(end) = input.word.end.checked_sub(origin) else {
            return (false, work);
        };
        let (row, base, _, visits) = self.rows.source_row_with_work(start);
        work += visits + 4;
        if input.opener.end != input.word.start
            || input.opener.len() != 1
            || input.word.is_empty()
            || end > base + row.source_len
        {
            return (false, work);
        }
        let start = start - base;
        let end = end - base;
        let first = row.segments.partition_point(|part| {
            work += 1;
            part.source.end <= start
        });
        let mut at = start;
        let mut shown = 0;
        for part in &row.segments[first..] {
            work += 2;
            if at == end {
                break;
            }
            if !part.identity || part.source.start > at || part.source.end <= at {
                return (false, work);
            }
            let to = part.source.end.min(end);
            let display = part.display.start + at - part.source.start;
            let Some(actual) = row.display.get(display..display + to - at) else {
                return (false, work);
            };
            for byte in actual.bytes() {
                let wanted = if shown == 0 {
                    Some(b'<')
                } else {
                    expected.as_bytes().get(shown - 1).copied()
                };
                work += 1;
                if Some(byte) != wanted {
                    return (false, work);
                }
                shown += 1;
            }
            at = to;
        }
        work += 1;
        if at != end || shown != expected.len() + 1 {
            return (false, work);
        }
        for span in &row.spans {
            work += 1;
            if span.open.start < end
                && start < span.close.end
                && matches!(span.kind, SpanKind::Link(_) | SpanKind::Format(_))
            {
                return (false, work);
            }
        }
        for block in &row.blocks {
            work += 1;
            if block.code && block.source.start < end && start < block.source.end {
                return (false, work);
            }
        }
        (true, work)
    }
}
