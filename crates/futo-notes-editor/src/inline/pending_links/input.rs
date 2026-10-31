//! Live pending-link activation and retirement for the accepted input intent.
use super::*;

impl Projection {
    pub(crate) fn finish_link_input(
        &mut self,
        input: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        caret: usize,
    ) -> usize {
        let mut work = 0;
        let word_bytes: usize = self
            .display
            .chars_at(self.display.byte_to_char(caret))
            .reversed()
            .take_while(|ch| !ch.is_whitespace())
            .map(char::len_utf8)
            .sum();
        let word = DisplayRange {
            start: DisplayOffset(caret - word_bytes),
            end: DisplayOffset(caret),
        };
        if matches!(
            action,
            crate::InputAction::Typing | crate::InputAction::CompositionCommit
        ) && !inserted.is_empty()
            && !inserted.chars().last().unwrap().is_whitespace()
        {
            let (links, query_work) = self.all_link_ranges(word);
            work += links.len() + query_work;
            for link in links {
                let index = self.rows.locate(link.start.0, true);
                let (row, _, display) = self.rows.at(index);
                work += row.spans.len() + row.literal_links.len();
                let bare = row
                    .spans
                    .iter()
                    .find(|span| {
                        matches!(span.kind, SpanKind::Link(_))
                            && span.open.is_empty()
                            && span.close.is_empty()
                            && display + row.display_at(span.open.end) == link.start.0
                            && display + row.display_at(span.close.start) == link.end.0
                    })
                    .map(|span| span.open.end..span.close.start);
                if let Some(bare) = bare {
                    if link.end.0 <= caret
                        && link.start.0 < input.start.0 + inserted.len()
                        && !row.literal_links.contains(&bare)
                    {
                        self.rows.metadata_mut(index).literal_links.push(bare);
                    }
                }
            }
        }
        if inserted.contains(char::is_whitespace) {
            let ended = caret
                - inserted
                    .rsplit(char::is_whitespace)
                    .next()
                    .unwrap_or("")
                    .len();
            let preceding: usize = self
                .display
                .chars_at(self.display.byte_to_char(input.start.0))
                .reversed()
                .take_while(|ch| !ch.is_whitespace())
                .map(char::len_utf8)
                .sum();
            let start = input.start.0 - preceding;
            let first = self.rows.locate(start, true);
            let last = self.rows.locate(ended, true);
            for index in first..=last {
                let (row, _, display) = self.rows.at(index);
                work += 2 * row.literal_links.len();
                let keep = row
                    .literal_links
                    .iter()
                    .filter(|range| {
                        !(start <= display + row.display_at(range.start)
                            && display + row.display_at(range.end) <= ended)
                    })
                    .cloned()
                    .collect();
                self.rows.metadata_mut(index).literal_links = keep;
            }
        }
        work
    }
}
