//! The tables and edits that decide whether an emphasis literal keeps a
//! paragraph whole.

/// Every line of the paragraph at `range` leads with `|`: a table, whose
/// rows hold no block syntax and whose seams may cut around emphasis literals.
pub(super) fn is_table(source: &str, range: &std::ops::Range<usize>) -> bool {
    let start = source[..range.start].rfind('\n').map_or(0, |at| at + 1);
    source[start..range.end]
        .lines()
        .all(|line| line.trim_start_matches(' ').starts_with('|'))
}

/// Whether replacing `removed` with `inserted` between `before` and `after`
/// (the bytes beside the edit) leaves every emphasis delimiter run, its
/// flanking and the paragraph's lines as they were.
pub(crate) fn delimiter_neutral(
    removed: &[u8],
    inserted: &[u8],
    before: Option<u8>,
    after: Option<u8>,
) -> bool {
    let delimiter = |byte: &u8| matches!(byte, b'*' | b'_' | b'~' | b'\\');
    let touches = |text: &[u8]| {
        text.iter()
            .any(|b| delimiter(b) || matches!(b, b'\n' | b'\r'))
    };
    !touches(removed)
        && !touches(inserted)
        && !before.is_some_and(|b| delimiter(&b))
        && !after.is_some_and(|b| delimiter(&b))
}
