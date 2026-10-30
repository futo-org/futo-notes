//! Visible range slicing retains exact spelling and inherited marker identity.
use super::{Piece, PieceOrigin};
use std::ops::Range;

pub(in crate::inline) struct Cut {
    pub(in crate::inline) before: Vec<Piece>,
    pub(in crate::inline) after: Vec<Piece>,
    pub(in crate::inline) left: Vec<usize>,
    pub(in crate::inline) right: Vec<usize>,
}

pub(in crate::inline) fn split_entities(pieces: Vec<Piece>, a: usize, z: usize) -> Vec<Piece> {
    let mut expanded = Vec::new();
    let mut position = 0;
    for piece in pieces {
        if piece.display.is_empty() {
            expanded.push(piece);
            continue;
        }
        let end = position + piece.display.len();
        let mut cuts = vec![0, piece.display.len()];
        for boundary in [a, z] {
            if position < boundary && boundary < end {
                cuts.push(boundary - position);
            }
        }
        cuts.sort_unstable();
        cuts.dedup();
        if cuts.len() == 2 {
            expanded.push(piece);
        } else {
            for pair in cuts.windows(2) {
                let display = piece.display[pair[0]..pair[1]].to_owned();
                let raw = if piece.raw == piece.display {
                    display.clone()
                } else {
                    display
                        .chars()
                        .map(|ch| format!("&#{};", ch as u32))
                        .collect()
                };
                expanded.push(Piece {
                    origin: if piece.raw == piece.display {
                        piece.origin.as_ref().map(|origin| match origin {
                            PieceOrigin::Source(source) => {
                                PieceOrigin::Source(source.start + pair[0]..source.start + pair[1])
                            }
                            PieceOrigin::Inserted(source) => PieceOrigin::Inserted(
                                source.start + pair[0]..source.start + pair[1],
                            ),
                        })
                    } else {
                        None
                    },
                    raw,
                    display,
                    spans: piece.spans.clone(),
                    trailing: piece.trailing,
                    definition: piece.definition.clone(),
                    timing: false,
                });
            }
        }
        position = end;
    }
    expanded
}

pub(in crate::inline) fn cut(expanded: Vec<Piece>, selected: Range<usize>, keep: bool) -> Cut {
    let (a, z) = (selected.start, selected.end);
    let mut offset = 0;
    let mut before = Vec::new();
    let mut after = Vec::new();
    let mut left = Vec::new();
    let mut right = Vec::new();
    for piece in expanded {
        let end = offset + piece.display.len();
        if offset < a && a <= end {
            left = piece.spans.clone();
        }
        if offset <= a && a < end {
            right = piece.spans.clone();
        }
        if piece.definition.is_some() {
            // Hidden declaration source was never part of the visible selection.
            if offset <= a {
                before.push(piece);
            } else {
                after.push(piece);
            }
        } else if piece.display.is_empty() && !piece.trailing && offset == z && a < z && !keep {
            // Joining lines retires the following line's block prefix. Its
            // inline spans still join through their visible pieces below.
        } else if piece.display.is_empty() && piece.trailing && offset >= z && !keep {
            after.push(piece);
        } else if keep || end <= a {
            before.push(piece);
        } else if offset >= z {
            after.push(piece);
        }
        // Scalar segments have no internal UTF-8 boundaries. Decoded text
        // events are split by the parser; preserve their raw atom intact.
        offset = end;
    }
    Cut {
        before,
        after,
        left,
        right,
    }
}
