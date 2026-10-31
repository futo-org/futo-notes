//! Ordered Typing alone seeds and advances a current source-owned WWW word.
use super::state::EmittedOrigin;
use super::*;
use crate::inline::{
    edit::EditIntent,
    references::ReferenceWork,
    row::{LinkMeaning, SpanKind},
    spelling::{Marker, Piece, PieceOrigin},
    Projection,
};
use crate::{DisplayRange, InlineFormat, InputAction};
mod ending;
mod literal;
mod seed;
mod separator;

pub(in crate::inline) struct Input<'a> {
    pub projection: &'a Projection,
    pub source_start: usize,
    pub range: DisplayRange,
    pub inserted: &'a str,
    pub intent: EditIntent,
    pub insertion: Range<usize>,
}
fn source_display(projection: &Projection, at: usize, work: &mut usize) -> usize {
    let (row, base, display, visits) = projection.rows.source_row_with_work(at);
    let (local, steps) = row.display_at_with_work(at - base);
    *work += visits + steps;
    display + local
}
fn safe(pieces: &[Piece], markers: &[Marker], work: &mut usize) -> bool {
    pieces.iter().all(|piece| {
        *work += 2;
        !piece.physical_prefix
            && piece.origin.is_some()
            && !piece.display.is_empty()
            && !piece.spans.iter().any(|id| {
                *work += 1;
                matches!(
                    markers[*id].kind,
                    SpanKind::Link(_) | SpanKind::Format(InlineFormat::Code)
                )
            })
    })
}
/// Exact whitespace-scalar ending bound, never origin or capsule authority by itself.
/// Both proof roles still validate their own retained or Inserted ownership.
pub(super) fn known_word_end(inserted: &str, work: &mut usize) -> bool {
    *work += 1;
    if inserted.len() != 1 {
        *work += 1;
        if !inserted
            .chars()
            .next_back()
            .is_some_and(|ch| ch.len_utf8() == inserted.len())
        {
            return false;
        }
    }
    terminal_word_end(inserted, work)
}
fn terminal_word_end(inserted: &str, work: &mut usize) -> bool {
    *work += 1;
    inserted.as_bytes().last().is_some_and(|byte| {
        *work += 1;
        if byte.is_ascii() {
            char::from(*byte).is_whitespace()
        } else {
            *work += 1;
            inserted
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace)
        }
    })
}
fn literal_prefix(word: &str, work: &mut usize) -> bool {
    *work += 1;
    word.len() <= 4 && phase::matches(word.as_bytes(), word.len(), work)
}
fn candidate(word: &str, work: &mut usize) -> bool {
    phase::matches(word.as_bytes(), word.len(), work)
}
fn canonical_links(word: &str, work: &mut ReferenceWork) -> Vec<crate::inline::row::Span> {
    if literal_prefix(word, &mut work.items) {
        work.items += 1;
        return Vec::new();
    }
    let (links, parsed, hint_items) = crate::inline::links::bare_links(word);
    work.items += hint_items;
    work.parsed += parsed;
    work.items += 1 + links.len();
    for span in &links {
        if let SpanKind::Link(target) = &span.kind {
            work.copied += target.destination.len() + target.title.as_ref().map_or(0, String::len);
        }
    }
    links
}
fn meaning(word: &str, work: &mut ReferenceWork) -> (Option<Arc<LinkMeaning>>, bool) {
    let links = canonical_links(word, work);
    let recognized = !links.is_empty();
    let Some(span) = links
        .first()
        .filter(|span| links.len() == 1 && span.open.start == 0 && span.close.end == word.len())
    else {
        return (None, recognized);
    };
    let SpanKind::Link(target) = &span.kind else {
        return (None, recognized);
    };
    if target.title.is_some() || target.reference.is_some() {
        return (None, recognized);
    }
    work.items += 1;
    (Some(target.clone()), recognized)
}
fn displayed(pieces: &[Piece], work: &mut ReferenceWork) -> String {
    let size = pieces
        .iter()
        .map(|piece| {
            work.items += 1;
            piece.display.len()
        })
        .sum();
    let mut result = String::with_capacity(size);
    work.items += usize::from(size > 0);
    for piece in pieces {
        work.items += 1;
        result.push_str(&piece.display);
        work.copied += piece.display.len();
    }
    result
}
fn inserted_run(pieces: &[Piece], input: &str, work: &mut usize) -> bool {
    let mut at = 0;
    for piece in pieces {
        *work += 3;
        let Some(PieceOrigin::Inserted(source)) = &piece.origin else {
            return false;
        };
        if source.start != at || source.end > input.len() {
            return false;
        }
        let Some(expected) = input.get(source.clone()) else {
            return false;
        };
        if !piece.display.bytes().zip(expected.bytes()).all(|(a, b)| {
            *work += 1;
            a == b
        }) || piece.display.len() != expected.len()
        {
            return false;
        }
        at = source.end;
    }
    at == input.len()
}
fn opaque(input: &Input<'_>, pieces: &[Piece], work: &mut usize) -> bool {
    let mut at = input.source_start;
    for piece in pieces[..input.insertion.start].iter().rev() {
        *work += 1;
        if let Some(PieceOrigin::Source(source)) = &piece.origin {
            at += source.end;
            break;
        }
    }
    let (row, base, _, visits) = input.projection.rows.source_row_with_work(at);
    *work += visits;
    row.blocks.iter().any(|block| {
        *work += 1;
        block.code && block.source.start <= at - base && at - base <= block.source.end
    })
}
impl TypedState {
    pub(in crate::inline) fn prepare_input(
        &mut self,
        input: Input<'_>,
        pieces: &mut [Piece],
        markers: &mut Vec<Marker>,
    ) -> Result<ReferenceWork, EditorError> {
        let mut work = ReferenceWork::default();
        work.items += self.prepare_input_mutations(
            input.projection,
            input.source_start,
            input.range,
            input.inserted,
            input.intent,
        );
        let typing = matches!(input.intent, EditIntent::Input(InputAction::Typing));
        work.items += 1;
        if !typing && !terminal_word_end(input.inserted, &mut work.items) {
            return Ok(work);
        }
        if input.inserted.is_empty() {
            return Ok(work);
        }
        if !inserted_run(
            &pieces[input.insertion.clone()],
            input.inserted,
            &mut work.items,
        ) {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut active = None;
        if let Some(origins) = &self.retained {
            for (index, origin) in origins.iter().enumerate() {
                let a = source_display(
                    input.projection,
                    input.source_start + origin.opener.start,
                    &mut work.items,
                );
                let z = source_display(
                    input.projection,
                    input.source_start + origin.word.end,
                    &mut work.items,
                );
                work.items += 4;
                if input.range.start == input.range.end && input.range.start.0 == z {
                    active = Some(index);
                } else if input.range.start.0 < z && a < input.range.end.0
                    || input.range.start == input.range.end
                        && a < input.range.start.0
                        && input.range.start.0 < z
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
        }
        if let Some(index) = active {
            let origin = self.retained.as_mut().unwrap().remove(index);
            // Build one source-ordered index for this actual field query, never
            // a text search or a per-endpoint reconstruction of an old display.
            let mut sources = Vec::with_capacity(pieces.len());
            work.items += usize::from(!pieces.is_empty());
            for (index, piece) in pieces.iter().enumerate() {
                work.items += 1;
                if let Some(PieceOrigin::Source(source)) = &piece.origin {
                    work.items += 3;
                    sources.push((source.clone(), index));
                }
            }
            let find = |range: &Range<usize>, work: &mut usize| -> Option<Range<usize>> {
                let first = sources.partition_point(|(source, _)| {
                    *work += 1;
                    source.end <= range.start
                });
                let mut at = range.start;
                let start = sources.get(first)?.1;
                let mut end = start;
                for (source, index) in &sources[first..] {
                    *work += 2;
                    if source.start >= range.end {
                        break;
                    }
                    if source.start != at || source.end > range.end || *index != end {
                        return None;
                    }
                    at = source.end;
                    end = index + 1;
                }
                (at == range.end).then_some(start..end)
            };
            let opener =
                find(&origin.opener, &mut work.items).ok_or(EditorError::UnrepresentableFormat)?;
            let body =
                find(&origin.word, &mut work.items).ok_or(EditorError::UnrepresentableFormat)?;
            if opener.len() != 1
                || opener.end != body.start
                || body.end != input.insertion.start
                || !safe(
                    &pieces[opener.start..input.insertion.end],
                    markers,
                    &mut work.items,
                )
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            if single_whitespace(input.inserted, &mut work.items) {
                ending::finish(pieces, markers, body, &origin, &mut work)?;
                return Ok(work);
            }
            let separator = separator::body_end(pieces, &input.insertion, &mut work.items);
            let mut end = separator.unwrap_or(input.insertion.end);
            work.items += 2;
            let closed = input.insertion.start < end && pieces[end - 1].display == ">";
            if closed {
                end -= 1;
            }
            if separator.is_some() || closed {
                let completed = body.start..end;
                if separator::word(pieces, completed.clone(), &mut work.items) {
                    if end == input.insertion.start {
                        ending::finish(pieces, markers, body, &origin, &mut work)?;
                    } else if typing {
                        ending::finish_typed(pieces, markers, completed, &mut work)?;
                    } else {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    return Ok(work);
                }
            }
            if input.inserted == ">" {
                ending::finish(pieces, markers, body, &origin, &mut work)?;
                return Ok(work);
            }
            if input.inserted.chars().any(|ch| {
                work.items += 1;
                ch.is_whitespace()
            }) {
                self.seed_last_word(&input, pieces, markers, &mut work)?;
                return Ok(work);
            }
            let body = body.start..input.insertion.end;
            let text = displayed(&pieces[body.clone()], &mut work);
            if !candidate(&text, &mut work.items) {
                return Ok(work);
            }
            let (target, _) = meaning(&text, &mut work);
            let uri = target.map(|meaning| {
                work.items += 2;
                work.copied += text.len();
                Arc::new(CodeWordIdentity {
                    meaning,
                    displayed: Arc::from(text),
                })
            });
            work.items += usize::from(self.emitted.len() == self.emitted.capacity());
            self.emitted.push(EmittedOrigin {
                opener: opener.start,
                body,
                uri,
            });
            return Ok(work);
        }
        if input.insertion.is_empty() {
            return Ok(work);
        }
        self.seed_last_word(&input, pieces, markers, &mut work)?;
        Ok(work)
    }
}
