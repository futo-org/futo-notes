//! `*`, `_` and `~~`: CommonMark's delimiter rules over one line.
use super::{url, Span, SpanKind};

#[derive(Clone, Debug)]
pub(super) struct Delimiter {
    pub(super) ch: u8,
    pub(super) region: usize,
    /// Unused delimiter characters occupy `lo..hi`. Openers are used from the
    /// `hi` end and closers from the `lo` end, so marks hug their text.
    pub(super) lo: usize,
    pub(super) hi: usize,
    pub(super) len: usize,
    pub(super) can_open: bool,
    pub(super) can_close: bool,
    pub(super) active: bool,
}

/// Unicode punctuation or symbol, close enough to CommonMark's classes:
/// format characters such as a zero-width space are neither.
pub(super) fn punctuation(ch: char) -> bool {
    ch.is_ascii_punctuation() || (!ch.is_ascii() && !ch.is_whitespace() && url::punctuation(ch))
}

/// Left and right flanking; the line's edges count as whitespace.
pub(super) fn flanking(before: Option<char>, after: Option<char>) -> (bool, bool) {
    let before_space = before.is_none_or(char::is_whitespace);
    let after_space = after.is_none_or(char::is_whitespace);
    let before_punct = before.is_some_and(punctuation);
    let after_punct = after.is_some_and(punctuation);
    let left = !after_space && (!after_punct || before_space || before_punct);
    let right = !before_space && (!before_punct || after_space || after_punct);
    (left, right)
}

/// CommonMark's "process emphasis" over one region's delimiters.
pub(super) fn emphasis(delimiters: &mut [Delimiter], spans: &mut Vec<Span>) {
    let mut bottoms: std::collections::HashMap<(u8, usize, bool), isize> = Default::default();
    let mut closer = 0usize;
    while closer < delimiters.len() {
        if !delimiters[closer].active || !delimiters[closer].can_close {
            closer += 1;
            continue;
        }
        let ch = delimiters[closer].ch;
        let closer_len = delimiters[closer].len;
        let closer_opens = delimiters[closer].can_open;
        let key = (ch, closer_len % 3, closer_opens);
        let floor = *bottoms.get(&key).unwrap_or(&-1);
        let mut opener = None;
        let mut j = closer as isize - 1;
        while j > floor {
            let d = &delimiters[j as usize];
            if d.active && d.can_open && d.ch == ch {
                let odd = (closer_opens || d.can_close)
                    && (d.len + closer_len).is_multiple_of(3)
                    && !(d.len.is_multiple_of(3) && closer_len.is_multiple_of(3));
                if !odd {
                    opener = Some(j as usize);
                    break;
                }
            }
            j -= 1;
        }
        let Some(open) = opener else {
            bottoms.insert(key, closer as isize - 1);
            if !closer_opens {
                delimiters[closer].active = false;
            }
            closer += 1;
            continue;
        };
        let width = if ch == b'~'
            || (delimiters[open].hi - delimiters[open].lo >= 2
                && delimiters[closer].hi - delimiters[closer].lo >= 2)
        {
            2
        } else {
            1
        };
        let open_marker = delimiters[open].hi - width..delimiters[open].hi;
        let close_marker = delimiters[closer].lo..delimiters[closer].lo + width;
        spans.push(Span {
            kind: match (ch, width) {
                (b'~', _) => SpanKind::Strike,
                (_, 2) => SpanKind::Bold,
                _ => SpanKind::Italic,
            },
            range: open_marker.start..close_marker.end,
            open: open_marker,
            close: close_marker,
        });
        for between in &mut delimiters[open + 1..closer] {
            between.active = false;
        }
        delimiters[open].hi -= width;
        if delimiters[open].hi == delimiters[open].lo {
            delimiters[open].active = false;
        }
        delimiters[closer].lo += width;
        if delimiters[closer].lo == delimiters[closer].hi {
            delimiters[closer].active = false;
            closer += 1;
        }
    }
}
