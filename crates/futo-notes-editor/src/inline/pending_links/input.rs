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
                #[cfg(test)]
                let visits = super::super::coordinate_work_tests::visits();
                let (index, a) = self.rows.locate_with_work(link.start.0, true);
                let (row, _, display, b) = self.rows.at_with_work(index);
                #[cfg(test)]
                let previous_work = work;
                work += a + b;
                let bare = row
                    .spans
                    .iter()
                    .find(|span| {
                        work += 1;
                        if !matches!(span.kind, SpanKind::Link(_))
                            || !span.open.is_empty()
                            || !span.close.is_empty()
                        {
                            return false;
                        }
                        let (start, a) = row.display_at_with_work(span.open.end);
                        work += a;
                        if display + start != link.start.0 {
                            return false;
                        }
                        let (end, z) = row.display_at_with_work(span.close.start);
                        work += z;
                        display + end == link.end.0
                    })
                    .map(|span| span.open.end..span.close.start);
                if let Some(bare) = bare {
                    if link.end.0 <= caret
                        && link.start.0 < input.start.0 + inserted.len()
                        && !row.literal_links.iter().any(|range| {
                            work += 1;
                            *range == bare
                        })
                    {
                        let (row, nodes) = self.rows.metadata_mut_with_work(index);
                        work += nodes;
                        row.literal_links.push(bare);
                    }
                }
                #[cfg(test)]
                super::super::coordinate_work_tests::query(
                    "pending-input-run",
                    visits,
                    work - previous_work,
                );
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
            let (first, a) = self.rows.locate_with_work(start, true);
            let (last, z) = self.rows.locate_with_work(ended, true);
            work += a + z;
            for index in first..=last {
                let (row, _, display, nodes) = self.rows.at_with_work(index);
                work += nodes;
                let keep = row
                    .literal_links
                    .iter()
                    .filter(|range| {
                        work += 2;
                        let (a, x) = row.display_at_with_work(range.start);
                        work += x;
                        if start > display + a {
                            return true;
                        }
                        let (z, y) = row.display_at_with_work(range.end);
                        work += y;
                        display + z > ended
                    })
                    .cloned()
                    .collect();
                let (row, nodes) = self.rows.metadata_mut_with_work(index);
                work += nodes;
                row.literal_links = keep;
            }
        }
        work
    }
}
