//! The actual Inserted terminal separator bounds a completed current word.
use super::*;

pub(super) fn body_end(
    pieces: &[Piece],
    insertion: &Range<usize>,
    work: &mut usize,
) -> Option<usize> {
    *work += 2;
    let end = insertion.end.checked_sub(1)?;
    // New bulk completion is deliberately one terminal ASCII Space. Existing
    // single-scalar Typing whitespace retains its separate established path.
    (!insertion.is_empty() && pieces[end].display == " ").then_some(end)
}

pub(super) fn word(pieces: &[Piece], body: Range<usize>, work: &mut usize) -> bool {
    pieces[body].iter().all(|piece| {
        *work += 1;
        piece.display.chars().all(|ch| {
            *work += 1;
            !ch.is_whitespace() && !matches!(ch, '<' | '>')
        })
    })
}
