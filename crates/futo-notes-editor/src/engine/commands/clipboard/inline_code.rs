//! Paste inside an inline code span: the text is code, so its own code marks
//! are left off rather than typed into the span.
use super::super::super::Engine;
use super::paste::read_alone;
use crate::lines::{line_spans, SpanKind};
use crate::{DisplayRange, InlineFormat};

/// `text` (one line) with the marks of its own inline code spans left off.
pub(super) fn code_text(text: &str) -> String {
    let line = read_alone(text);
    let spans = line_spans(text, &line);
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for span in spans.iter().filter(|span| span.kind == SpanKind::Code) {
        out.push_str(&text[at..span.open.start]);
        out.push_str(&text[span.open.end..span.close.start]);
        at = span.close.end;
    }
    out.push_str(&text[at..]);
    out
}

impl Engine {
    /// Whether the paste lands inside an inline code span's text: at the
    /// offset input at a caret lands at, else at the selection's start.
    pub(super) fn in_inline_code(&self, range: DisplayRange) -> bool {
        let at = if range.start == range.end {
            self.input_at(range)
        } else {
            self.source_selection(range).start
        };
        self.formats_at(at).contains(&InlineFormat::Code)
    }
}
