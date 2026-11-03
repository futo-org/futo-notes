//! Word seams: a long line is cut inside a space-delimited word of ASCII
//! letters, which no inline construct reads across (#314).
#[cfg(test)]
use super::NO_WORD_SEAMS;

/// The longest word a word seam may cut.
pub(super) const WORD_MAX: usize = 32;
/// Bytes of a preceding row that hold any word a seam cuts, with its space.
pub(crate) const WORD_TAIL: usize = WORD_MAX + 1;

/// `before` ends and `after` starts inside one word of ASCII letters that
/// spaces delimit within the same line.
pub(crate) fn word_seam(before: &str, after: &str) -> bool {
    let (b, a) = (before.as_bytes(), after.as_bytes());
    let letters = |bytes: &mut dyn Iterator<Item = &u8>| {
        bytes
            .take(WORD_MAX + 1)
            .take_while(|b| b.is_ascii_alphabetic())
            .count()
    };
    let left = letters(&mut b.iter().rev());
    let right = letters(&mut a.iter());
    left > 0
        && right > 0
        && left + right <= WORD_MAX
        && b.len() > left
        && b[b.len() - left - 1] == b' '
        && a.get(right) == Some(&b' ')
}

/// The first word seam at or after `from` in the line `line`.
pub(super) fn next_word_seam(
    source: &str,
    line: std::ops::Range<usize>,
    from: usize,
) -> Option<usize> {
    #[cfg(test)]
    if NO_WORD_SEAMS.with(|plain| plain.get()) {
        return None;
    }
    let bytes = source.as_bytes();
    let mut at = from.max(line.start + 1);
    while at < line.end {
        if bytes[at - 1].is_ascii_alphabetic()
            && bytes[at].is_ascii_alphabetic()
            && word_seam(&source[line.start..at], &source[at..line.end])
        {
            return Some(at);
        }
        at += 1;
    }
    None
}

/// A word seam between `before` and `after` holds: it cuts one word, in a
/// line without `|` (a line holding one may be a table row: word seams never
/// cut it).
pub(super) fn sealed(before: &str, after: &str) -> bool {
    let line = |text: &str| !text.contains('|');
    word_seam(before, after)
        && line(before.rsplit('\n').next().unwrap_or_default())
        && line(after.split('\n').next().unwrap_or_default())
}
