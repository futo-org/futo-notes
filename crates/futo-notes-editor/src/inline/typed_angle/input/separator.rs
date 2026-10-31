//! The actual Inserted terminal separator bounds a completed current word.
use super::*;

pub(super) fn body_end(
    pieces: &[Piece],
    insertion: &Range<usize>,
    work: &mut usize,
) -> Option<usize> {
    *work += 2;
    let end = insertion.end.checked_sub(1)?;
    // Exactly one current whitespace scalar bounds this word. It is not a
    // whitespace-run trim or authority for a new origin/capsule by itself.
    (!insertion.is_empty() && known_word_end(&pieces[end].display, work)).then_some(end)
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
