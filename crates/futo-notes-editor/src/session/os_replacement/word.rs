//! A word completion under a toggled format (#360).
use super::*;

impl EditorSession {
    /// A completion (`hel` to `hello`) diffs to the letters typed at the caret, which take the
    /// carried formats while the word's own letters keep theirs: Bold turned off after `hel`
    /// would save `**hel**lo`. The whole word takes the carried formats instead, but only when
    /// that changes nothing the user did not toggle: the word before the caret is one plain
    /// stretch (`Projection::plain_word`) whose formats are the ones the caret had before
    /// the user toggled there, and the run at the caret continues the word.
    pub(super) fn word_split_by_carried(
        &self,
        range: DisplayRange,
        old: &str,
        text: &str,
        runs: &[crate::DisplayReplacement],
        carried: Option<&[InlineFormat]>,
    ) -> bool {
        let Some(carried) = carried else {
            return false;
        };
        // Letters only, and a whole word: punctuation can be Markdown, and a letter beside the
        // word may be respelled to keep it apart from the word's new markers.
        let letter = |c: char| c.is_alphanumeric() || "'’".contains(c);
        let letters = |word: &str| !word.is_empty() && word.chars().all(letter);
        let display = &self.projection.display;
        let start = display.byte_to_char(range.start.0);
        let end = display.byte_to_char(range.end.0);
        let beside = |at: Option<usize>| at.and_then(|at| display.get_char(at)).is_some_and(letter);
        if range.start.0 >= self.selection.end.0
            || !runs
                .iter()
                .any(|run| run.range == self.selection && !run.inserted.trim().is_empty())
            || !letters(old)
            || !letters(text.trim_end_matches(' '))
            || beside(start.checked_sub(1))
            || beside(Some(end))
        {
            return false;
        }
        let Some(word) = self
            .projection
            .plain_word(&self.source, range.start.0..range.end.0)
        else {
            return false;
        };
        let Some((revision, selection, own)) = &self.toggled_from else {
            return false;
        };
        let mut carried = carried.to_vec();
        carried.sort();
        carried.dedup();
        (*revision, *selection) == (self.revision, self.selection)
            && word == *own
            && carried != *own
    }
}
