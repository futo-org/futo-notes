//! Current exact-word authorization, independent of outer source spelling.
use crate::inline::{
    row::SpanKind,
    spelling::{CodeLiteralColon, Marker, Piece, PieceOrigin},
};
use crate::InlineFormat;
use std::ops::Range;

/// Stop before a canonical physical prefix without dropping its bytes. Empty
/// carriers and inline markers never become physical boundaries by shape.
pub(super) fn word_start(pieces: &[Piece], insertion: usize, work: &mut usize) -> usize {
    let mut start = insertion;
    while start > 0 {
        *work += 1;
        let previous = &pieces[start - 1];
        if previous.physical_prefix
            || previous.display.chars().any(|ch| {
                *work += 1;
                ch.is_whitespace()
            })
        {
            break;
        }
        start -= 1;
    }
    start
}

pub(super) struct OwnedWord {
    pub source: Range<usize>,
    pub guard: Option<usize>,
}

pub(super) fn authorize(
    pieces: &[Piece],
    markers: &[Marker],
    word: Range<usize>,
    displayed: usize,
    guards: &crate::inline::guarded_words::GuardState,
    work: &mut usize,
) -> Option<OwnedWord> {
    let mut source: Option<Range<usize>> = None;
    let mut pending = None;
    let mut at = 0;
    for piece in &pieces[word.clone()] {
        *work += 1;
        // A Code or already active link owns the word. Word-end input cannot
        // enroll or override either, even if its display looks like a URI.
        for id in &piece.spans {
            *work += 1;
            match &markers[*id].kind {
                SpanKind::Format(InlineFormat::Code) => return None,
                SpanKind::Link(_) if !markers[*id].pending => return None,
                _ => {}
            }
        }
        *work += 1;
        let Some(PieceOrigin::Source(range)) = &piece.origin else {
            return None;
        };
        if let Some(previous) = &mut source {
            *work += 1;
            if previous.end != range.start {
                return None;
            }
            previous.end = range.end;
        } else {
            source = Some(range.clone());
        }
        let end = at + piece.display.len();
        if at == 1 && end <= displayed - 1 {
            pending = piece.spans.iter().copied().find(|id| {
                *work += 1;
                markers[*id].pending && matches!(markers[*id].kind, SpanKind::Link(_))
            });
        }
        at = end;
    }
    let source = source?;
    // The whole envelope and every inner piece must belong to this exact
    // supplied owner. A trusted scalar or equal URI never grants lifetime.
    if let Some(first) = pieces[word.start].guard {
        use crate::inline::guarded_words::GuardRole;
        *work += 2;
        if first.role != GuardRole::Open || guards.owners.get(first.id)?.is_none() {
            return None;
        }
        let mut at = 0;
        for piece in &pieces[word.clone()] {
            *work += 2;
            let part = piece.guard?;
            let end = at + piece.display.len();
            let role = if at == 0 && end == 1 {
                GuardRole::Open
            } else if at == displayed - 1 && end == displayed {
                GuardRole::Close
            } else if 1 <= at && end <= displayed - 1 {
                GuardRole::Inner
            } else {
                return None;
            };
            if part.id != first.id || part.role != role {
                return None;
            }
            at = end;
        }
        return Some(OwnedWord {
            source,
            guard: Some(first.id),
        });
    }
    let pending = pending?;
    // One actual context-unique pending marker must own the complete inner
    // body. Equal labels/destinations cannot combine different identities.
    at = 0;
    for (index, piece) in pieces.iter().enumerate() {
        *work += 1;
        let in_word = word.contains(&index);
        let end = if in_word {
            at + piece.display.len()
        } else {
            at
        };
        let owns = piece.spans.iter().any(|id| {
            *work += 1;
            *id == pending
        });
        if in_word {
            if !piece.display.is_empty() && 1 <= at && end <= displayed - 1 && !owns {
                return None;
            }
            at = end;
        } else if owns {
            return None;
        }
    }
    Some(OwnedWord {
        source,
        guard: None,
    })
}

pub(super) fn consume_colons(pieces: &mut [Piece], work: &mut usize) {
    for piece in pieces {
        *work += 1;
        if CodeLiteralColon::read(piece, work).is_some() {
            piece.timing = false;
        }
    }
}
