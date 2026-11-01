//! Plain Markdown clipboard: copy exports exact source for a display selection,
//! cut removes it as one action, and paste reads plain text as Markdown while
//! keeping the copied characters. Rich HTML conversion is a separate policy.
use super::*;

mod copy;
mod paste;

impl EditorSession {
    fn physical_start(&self, at: usize) -> usize {
        let mut at = at;
        while at > 0 && self.source.byte(at - 1) != b'\n' {
            at -= 1;
        }
        at
    }

    /// Line end before its CR/LF ending.
    fn physical_end(&self, at: usize) -> usize {
        let len = self.source.len_bytes();
        let mut at = at;
        while at < len && !matches!(self.source.byte(at), b'\n' | b'\r') {
            at += 1;
        }
        at
    }
}

fn shift(range: &std::ops::Range<usize>, by: usize) -> std::ops::Range<usize> {
    range.start + by..range.end + by
}
