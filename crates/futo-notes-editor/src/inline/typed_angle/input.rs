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
fn literal_prefix(word: &str) -> bool {
    matches!(word, "w" | "ww" | "www" | "www.")
}
fn candidate(word: &str) -> bool {
    literal_prefix(word) || word.starts_with("www.")
}
fn meaning(word: &str, work: &mut ReferenceWork) -> (Option<Arc<LinkMeaning>>, bool) {
    if literal_prefix(word) {
        work.items += 1;
        return (None, false);
    }
    let (links, parsed) = crate::inline::links::bare_links(word);
    work.parsed += parsed;
    work.items += 1 + links.len();
    for span in &links {
        if let SpanKind::Link(target) = &span.kind {
            work.copied += target.destination.len() + target.title.as_ref().map_or(0, String::len);
        }
    }
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
        if !matches!(input.intent, EditIntent::Input(InputAction::Typing)) {
            work.items += self.require_unchanged_input(
                input.projection,
                input.source_start,
                input.range,
                input.inserted,
                input.intent,
            )?;
            return Ok(work);
        }
        if input.inserted.is_empty() {
            return Ok(work);
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
            if !inserted_run(
                &pieces[input.insertion.clone()],
                input.inserted,
                &mut work.items,
            ) {
                return Err(EditorError::UnrepresentableFormat);
            }
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
            let ending = input.inserted.chars().count() == 1
                && input
                    .inserted
                    .chars()
                    .next()
                    .is_some_and(char::is_whitespace);
            if input.inserted == ">" || ending {
                let text = displayed(&pieces[body.clone()], &mut work);
                let (target, recognized) = meaning(&text, &mut work);
                let Some(target) = target else {
                    if recognized {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    return Ok(work); // An invalid/incomplete candidate simply ends.
                };
                let saved = origin
                    .uri
                    .as_ref()
                    .ok_or(EditorError::UnrepresentableFormat)?;
                work.items += saved.displayed.len()
                    + text.len()
                    + saved.meaning.destination.len()
                    + target.destination.len()
                    + 2;
                if saved.displayed.as_ref() != text || saved.meaning != target {
                    return Err(EditorError::UnrepresentableFormat);
                }
                let id = markers.len();
                markers.push(Marker {
                    source: None,
                    literal_url: false,
                    pending: true,
                    activate: false,
                    kind: SpanKind::Link(target),
                    open: "<".into(),
                    close: ">".into(),
                });
                work.items += 1;
                work.copied += 2;
                for piece in &mut pieces[body] {
                    work.items += 1;
                    piece.spans.push(id);
                }
                // Existing spelling's final canonical verifier chooses explicit
                // syntax for WWW. Space retires pending in the ordinary input owner.
                return Ok(work);
            }
            if input.inserted.contains(char::is_whitespace) || input.inserted.contains(['<', '>']) {
                return Err(EditorError::UnrepresentableFormat);
            }
            let body = body.start..input.insertion.end;
            let text = displayed(&pieces[body.clone()], &mut work);
            if !candidate(&text) {
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
        if input.range.start != input.range.end || input.insertion.is_empty() {
            return Ok(work);
        }
        let inserted = &pieces[input.insertion.clone()];
        let (opener, body) = if inserted.first().is_some_and(|piece| piece.display == "<") {
            (
                input.insertion.start,
                input.insertion.start + 1..input.insertion.end,
            )
        } else if input.insertion.start > 0 && pieces[input.insertion.start - 1].display == "<" {
            (input.insertion.start - 1, input.insertion.clone())
        } else {
            return Ok(work);
        };
        if body.is_empty()
            || !inserted_run(inserted, input.inserted, &mut work.items)
            || !safe(&pieces[opener..body.end], markers, &mut work.items)
        {
            return Ok(work);
        }
        let prefix: [&str; 4] = std::array::from_fn(|index| {
            work.items += 1;
            pieces
                .get(body.start + index)
                .filter(|_| body.start + index < body.end)
                .map_or("", |piece| piece.display.as_str())
        });
        let small = body.len() <= 3 && prefix[..body.len()].iter().all(|part| *part == "w");
        if !(small || prefix == ["w", "w", "w", "."]) {
            return Ok(work);
        }
        let text = displayed(&pieces[body.clone()], &mut work);
        work.items += 1;
        if !candidate(&text) {
            return Ok(work);
        }
        if text.contains(char::is_whitespace) || text.contains(['<', '>']) {
            return Err(EditorError::UnrepresentableFormat);
        }
        // A source suffix would be retained inner text, not a newly inserted
        // whole seed. A separate later input must own any such continuation.
        if pieces.get(input.insertion.end).is_some_and(|piece| {
            !piece.display.is_empty() && !piece.display.chars().all(char::is_whitespace)
        }) {
            return Ok(work);
        }
        if opaque(&input, pieces, &mut work.items) {
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
        self.emitted.push(EmittedOrigin { opener, body, uri });
        Ok(work)
    }
}
