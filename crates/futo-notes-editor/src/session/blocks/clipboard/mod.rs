//! Plain Markdown clipboard: copy exports exact source for a display selection,
//! cut removes it as one action, and paste reads plain text as Markdown while
//! keeping the copied characters. Rich HTML conversion is a separate policy.
use super::*;

mod copy;
mod paste;
mod selected;

/// Start of the line holding `at`.
fn line_start(text: &ropey::Rope, at: usize) -> usize {
    let mut at = at;
    while at > 0 && text.byte(at - 1) != b'\n' {
        at -= 1;
    }
    at
}

/// Line end before its CR/LF ending.
fn line_end(text: &ropey::Rope, at: usize) -> usize {
    let len = text.len_bytes();
    let mut at = at;
    while at < len && !matches!(text.byte(at), b'\n' | b'\r') {
        at += 1;
    }
    at
}

fn shift(range: &std::ops::Range<usize>, by: usize) -> std::ops::Range<usize> {
    range.start + by..range.end + by
}

/// Staging carries the already normalized clipboard text and original caret
/// ending; deletion must not change either or trim another trailing ending.
#[derive(Clone, Copy)]
enum PasteInput<'a> {
    Clipboard(&'a str),
    Normalized { text: &'a str, newline: &'a str },
}

impl<'a> PasteInput<'a> {
    fn text(self) -> &'a str {
        match self {
            Self::Clipboard(text) | Self::Normalized { text, .. } => text,
        }
    }
}

impl EditorSession {
    /// Plain-text paste read as Markdown: copied characters, edge whitespace and
    /// soft lines stay exact; blocks take their own lines inside the caret's
    /// containers; one trailing copied line ending is dropped and pasted line
    /// endings follow the caret line. The paste is one isolated history action.
    pub fn paste_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.paste_input(expected, range, PasteInput::Clipboard(text), accept)
    }
}
