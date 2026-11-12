//! A selection that cuts a fence's frame. Replacing it joins the text after
//! it to the line it starts on, as across any lines; a fence frame line in
//! the removed text whose block goes on outside it is kept, after the
//! joined line, so no line outside the selection changes how it reads.
use super::super::super::Engine;
use crate::lines::FenceRole;

impl Engine {
    /// When removing source `start..end` takes a closing line whose block
    /// starts before `start`, or an opening line whose block goes on after
    /// `end`: the source `end..to` and the text that replaces it (the rest
    /// of the joined line, then the frame lines). An opening line whose
    /// block has no code line left goes with its closing line. Reads only
    /// the lines the selection spans and the one after them.
    pub(crate) fn kept_frame(&self, start: usize, end: usize) -> Option<(usize, String)> {
        let first = self.line_of(start);
        let last = self.line_of(end);
        let cut = |index: usize| {
            let at = self.line_start(index);
            start <= at && at + self.line(index).body_len() <= end
        };
        // The closing line of the block the selection starts in.
        let closing = matches!(self.role(first), Some(FenceRole::Code | FenceRole::Open))
            .then(|| (first + 1..=last).find(|&index| self.role(index) == Some(FenceRole::Close)))
            .flatten()
            .filter(|&index| cut(index));
        // The opening line of the block the selection ends in.
        let mut open = last;
        while open > first && self.is_code(open) {
            open -= 1;
        }
        let opening = (open > first
            && self.role(open) == Some(FenceRole::Open)
            && (open == last || self.is_code(last))
            && cut(open))
        .then_some(open);
        if closing.is_none() && opening.is_none() {
            return None;
        }
        let count = self.line_count();
        let entry = self.line(last);
        let line_start = self.line_start(last);
        let mut text = self.source_slice(end..line_start + entry.body_len());
        let mut to = line_start + entry.text.len();
        let mut ending = entry.ending().to_owned();
        let mut frames = Vec::new();
        if let Some(index) = closing {
            frames.push(self.line(index).body());
        }
        if let Some(open) = opening {
            if last + 1 < count && self.is_code(last + 1) {
                frames.push(self.line(open).body());
            } else if last + 1 < count && self.role(last + 1) == Some(FenceRole::Close) {
                // Nothing of the block is left: its closing line goes too.
                let closing = self.line(last + 1);
                to = self.line_start(last + 1) + closing.text.len();
                ending = closing.ending().to_owned();
            }
        }
        let eol = self.new_ending(last);
        for frame in frames {
            text.push_str(&eol);
            text.push_str(frame);
        }
        text.push_str(&ending);
        Some((to, text))
    }
}
