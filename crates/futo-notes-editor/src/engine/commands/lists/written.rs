//! A line as a list command or a move writes it, and where an old position
//! in it lands.
use crate::lines::{Kind, Line};

/// A rewritten line: its new body, where the text before `old_cut` in the
/// old line became the text before `new_cut`, with one `\` written at
/// `escape` (relative to the cut) when one was needed. `markers` holds where
/// the marker started in the old line and starts in the new one, when both
/// are items.
#[derive(Clone, Debug)]
pub(in crate::engine::commands) struct Written {
    pub body: String,
    pub old_cut: usize,
    pub new_cut: usize,
    pub escape: Option<usize>,
    pub markers: Option<(usize, usize)>,
}

impl Written {
    pub fn kept(body: &str) -> Self {
        Self {
            body: body.to_owned(),
            old_cut: 0,
            new_cut: 0,
            escape: None,
            markers: None,
        }
    }

    /// Where old line-relative offset `at` (inside the old body) lands: a
    /// position up to the old marker's start lands at the new marker's
    /// start, and any other position in the rewritten prefix where the text
    /// starts.
    pub fn map(&self, at: usize) -> usize {
        if let Some((_, new)) = self.markers.filter(|&(old, _)| at <= old) {
            return new;
        }
        if at <= self.old_cut {
            return self.new_cut;
        }
        let into = at - self.old_cut;
        self.new_cut + into + usize::from(self.escape.is_some_and(|k| into > k))
    }
}

/// Where item `line`'s marker unit starts, line-relative; `None` for a line
/// that is not an item.
pub(super) fn marker_start(line: &Line) -> Option<usize> {
    match &line.kind {
        Kind::List { text, .. } => Some(text.start),
        _ => None,
    }
}
