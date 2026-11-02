//! Plain Markdown clipboard: copy exports exact source for a display selection,
//! cut removes it as one action, and paste reads plain text as Markdown while
//! keeping the copied characters. Rich HTML conversion is a separate policy.
use super::*;

mod copy;
mod paste;

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
