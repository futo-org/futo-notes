//! Backspace in an empty pair: one level of it goes.
use super::super::super::{read, Engine};
use super::caret::empty_level;
use super::pairs::PAIRS;
use crate::lines::{Kind, SpanKind};
use crate::{DisplayOffset, DisplayRange};

impl Engine {
    /// The display range of one level of the empty pair a collapsed caret
    /// is between (`empty_level`: `` `‸` ``, `***‸***`, `~~‸~~`, `[[‸]]`),
    /// outside code, front matter and inline code. `None` anywhere else,
    /// and while text is marked.
    pub(crate) fn empty_pair(&self, range: DisplayRange) -> Option<DisplayRange> {
        self.check_display_range(range).ok()?;
        if range.start != range.end || self.composition.is_some() {
            return None;
        }
        let at = self.input_at(self.outside_crlf(range));
        let (index, before) = read::line_at(&self.store, at);
        let entry = self.store.get(index);
        if matches!(entry.line.kind, Kind::Fence { .. } | Kind::FrontMatter(_)) {
            return None;
        }
        let local = at - before.source;
        let in_code = entry.spans.iter().any(|span| {
            span.kind == SpanKind::Code && span.open.start <= local && local <= span.close.end
        });
        if in_code {
            return None;
        }
        let pair = PAIRS
            .iter()
            .find(|pair| empty_level(entry, pair, local).is_some())?;
        Some(DisplayRange {
            start: DisplayOffset(self.display_of(at - pair.open.len())),
            end: DisplayOffset(self.display_of(at + pair.close.len())),
        })
    }
}
