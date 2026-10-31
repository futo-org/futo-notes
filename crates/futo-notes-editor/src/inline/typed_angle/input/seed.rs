//! The last current Inserted word reuses the original WWW seed/ending owner.
use super::*;

impl TypedState {
    /// prepare_input has verified the COMPLETE original Inserted run once.
    /// Prefix bytes never authorize this word; its opener and inner text are
    /// current Inserted pieces, except the existing lone retained opener case.
    pub(super) fn seed_last_word(
        &mut self,
        input: &Input<'_>,
        pieces: &mut [Piece],
        markers: &mut Vec<Marker>,
        work: &mut ReferenceWork,
    ) -> Result<(), EditorError> {
        let ending = separator::body_end(pieces, &input.insertion, &mut work.items);
        let end = ending.unwrap_or(input.insertion.end);
        let mut start = end;
        while input.insertion.start < start {
            work.items += 1;
            if pieces[start - 1].display.chars().any(|ch| {
                work.items += 1;
                ch.is_whitespace()
            }) {
                break;
            }
            start -= 1;
        }
        if start == end {
            // Preserve the non-conversion decision with ordinary literal
            // source, without trimming separators into activation authority.
            return self.literal_ending(input, pieces, markers, work);
        }
        work.items += 1;
        let closed = pieces[end - 1].display == ">";
        let body_end = end - usize::from(closed);
        let (opener, body) = if pieces[start].display == "<" {
            (start, start + 1..body_end)
        } else if start == input.insertion.start && start > 0 && pieces[start - 1].display == "<" {
            (start - 1, start..body_end)
        } else {
            return Ok(());
        };
        let typing = matches!(input.intent, EditIntent::Input(InputAction::Typing));
        // Committed completion owns a whole newly Inserted closed capsule
        // with an actual terminal separator. It never adopts an authored
        // opener or creates an unfinished live seed.
        if !typing && (ending.is_none() || !closed || opener < input.insertion.start) {
            return Ok(());
        }
        if body.is_empty() || !safe(&pieces[opener..end], markers, &mut work.items) {
            return Ok(());
        }
        // An unfinished insertion cannot adopt retained inner suffix text.
        if ending.is_none()
            && !closed
            && pieces.get(input.insertion.end).is_some_and(|piece| {
                work.items += 1;
                !piece.display.is_empty()
                    && !piece.display.chars().all(|ch| {
                        work.items += 1;
                        ch.is_whitespace()
                    })
            })
        {
            return Ok(());
        }
        if opaque(input, pieces, &mut work.items) {
            return Ok(());
        }
        if ending.is_some() || closed {
            ending::finish_typed(pieces, markers, body, work)?;
            return Ok(());
        }
        let mut prefix = [0u8; 4];
        for (index, piece) in pieces[body.clone()].iter().take(4).enumerate() {
            work.items += 1;
            if piece.display.len() != 1 {
                return Ok(());
            }
            prefix[index] = piece.display.as_bytes()[0];
        }
        if !phase::matches(&prefix, body.len(), &mut work.items) {
            return Ok(());
        }
        let text = displayed(&pieces[body.clone()], work);
        if !candidate(&text, &mut work.items) {
            return Ok(());
        }
        let (target, _) = meaning(&text, work);
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
        Ok(())
    }
}
