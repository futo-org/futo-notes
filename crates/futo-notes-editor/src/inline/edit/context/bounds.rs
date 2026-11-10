//! Source window boundaries and candidate isolation for inline input.
use super::*;

impl Projection {
    /// A candidate replacing source `start..end` is sealed when it cannot
    /// pair with syntax in a neighboring row of the same cut paragraph.
    pub(in crate::inline::edit) fn sealed_candidate(
        &self,
        source: &Rope,
        start: usize,
        end: usize,
        output: &str,
    ) -> (bool, usize) {
        let first = self.rows.at(self.rows.locate(start, false)).0;
        let index = self.rows.locate(end, false);
        let (following, at, _) = self.rows.at(index);
        let next = (at == end && end > start)
            .then(|| self.continued_line(source, index, end))
            .flatten();
        let following_row = at == end && end > start;
        let next_opener = following.opener.as_deref().filter(|_| following_row);
        // A cut raw HTML or fenced block must still end where its rows say it does.
        let mut parsed = 0;
        if following_row && (first.opener.is_some() || next_opener.is_some()) {
            let opener = first.opener.as_deref().unwrap_or("");
            let text = format!("{opener}{output}");
            parsed += text.len();
            if crate::inline::row::open_tail(&text) != next_opener {
                return (false, parsed);
            }
        }
        if !first.continues && next.is_none() {
            return (true, parsed);
        }
        let first_index = self.rows.locate(start, false);
        let previous = self.previous_tail(source, first_index, start);
        let outside = crate::inline::row::Outside {
            previous: previous.as_deref(),
            continues: first.continues,
            first_number: first.first_number(),
            opener: first.opener.as_deref(),
            next: next.as_deref(),
            next_opener: next.as_ref().and(next_opener),
            followed: end < source.len_bytes(),
            neutral: neutral_replacement(source, start, end, output),
            context: first.context.as_deref(),
            next_context: next
                .as_ref()
                .and(following.context.as_deref().filter(|_| following_row)),
        };
        let found = crate::inline::row::partition(output, outside);
        (
            !found.widen_back && !found.widen_forward,
            parsed + output.len(),
        )
    }

    /// Rows `first..=last` widened to the blank-separated piece an uncut row
    /// would hold, never into front matter.
    pub(super) fn uncut_piece(
        &self,
        source: &Rope,
        mut first: usize,
        mut last: usize,
    ) -> (usize, usize) {
        // The blank-separated piece an uncut row would hold.
        let ends_blank = |index: usize| {
            let (row, start, _) = self.rows.at(index);
            let end = start + row.source_len;
            // The last four bytes, widened back to a character boundary.
            let from = source.char_to_byte(source.byte_to_char(start.max(end.saturating_sub(4))));
            let tail = source.byte_slice(from..end).to_string();
            tail.ends_with("\n\n") || tail.ends_with("\n\r\n") || row.source_len <= 2
        };
        while first > 0
            && !self.rows.at(first - 1).0.metadata
            && (self.rows.at(first).0.continues || !ends_blank(first - 1))
        {
            first -= 1;
        }
        while last + 1 < self.rows.len()
            && (self.rows.at(last + 1).0.continues || !ends_blank(last))
        {
            last += 1;
        }
        (first, last)
    }
}
