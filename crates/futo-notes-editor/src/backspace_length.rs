const ZERO_WIDTH_NON_JOINER: char = '\u{200c}';

/// How many bytes from the end of `cluster`, the extended grapheme before a
/// caret, Backspace removes: the whole cluster, except a trailing zero-width
/// non-joiner alone, which Unicode attaches to the letter before it.
pub(crate) fn backspace_length(cluster: &str) -> usize {
    if cluster.ends_with(ZERO_WIDTH_NON_JOINER) {
        return ZERO_WIDTH_NON_JOINER.len_utf8();
    }
    cluster.len()
}
