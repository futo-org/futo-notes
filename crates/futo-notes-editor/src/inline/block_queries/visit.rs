//! Block lines a display range touches, row by row. Each row's lines depend
//! only on that row and the tree, so a long range is read in parallel runs.
use super::*;

/// Rows per independently read run.
const RUN_ROWS: usize = 16;

impl Projection {
    pub(super) fn visit_block_lines(
        &self,
        range: DisplayRange,
        formatting: bool,
        mut visit: impl FnMut(&blocks::BlockLine, usize, usize),
    ) {
        let (rows, note_end) = self.block_line_rows(range);
        for index in rows {
            self.visit_row_lines(index, range, formatting, note_end, &mut visit);
        }
    }

    /// `read` of every line [`Self::visit_block_lines`] visits, in order,
    /// with long ranges read on several cores.
    pub(super) fn collect_block_lines<T: Send>(
        &self,
        range: DisplayRange,
        formatting: bool,
        read: impl Fn(&blocks::BlockLine, usize, usize) -> T + Sync + Send,
    ) -> Vec<T> {
        let (rows, note_end) = self.block_line_rows(range);
        let (first, last) = (*rows.start(), *rows.end());
        let runs: Vec<_> = (first..=last)
            .step_by(RUN_ROWS)
            .map(|start| start..=(start + RUN_ROWS - 1).min(last))
            .collect();
        crate::parallel::map(&runs, |run| {
            let mut found = Vec::new();
            for index in run.clone() {
                self.visit_row_lines(
                    index,
                    range,
                    formatting,
                    note_end,
                    &mut |block, base, index| {
                        found.push(read(block, base, index));
                    },
                );
            }
            found
        })
        .into_iter()
        .flatten()
        .collect()
    }

    /// The rows a range's block lines come from, and the note's source end.
    fn block_line_rows(&self, range: DisplayRange) -> (std::ops::RangeInclusive<usize>, usize) {
        let first = self.line_head(self.rows.locate(range.start.0, true));
        let last = self.rows.locate(range.end.0, true);
        let note_end =
            self.rows.at(self.rows.len() - 1).1 + self.rows.at(self.rows.len() - 1).0.source_len;
        (first..=last, note_end)
    }

    fn visit_row_lines(
        &self,
        index: usize,
        range: DisplayRange,
        formatting: bool,
        note_end: usize,
        visit: &mut dyn FnMut(&blocks::BlockLine, usize, usize),
    ) {
        let (row, source, display) = self.rows.at(index);
        let joined = self.joins_next(index);
        for (at, block) in row.blocks.iter().enumerate() {
            if block.empty_comment || at == 0 && row.mid_line {
                continue;
            }
            if joined && at + 1 == row.blocks.len() {
                // One physical line cut at word seams: plain paragraph text.
                let (line, _, last_block) = self.joined_line(index);
                let a = self.display_at(line.source.start);
                let z = self.display_at(line.source.end);
                let hit = if range.start == range.end {
                    a <= range.start.0
                        && (range.start.0 < z || last_block && line.source.end == note_end)
                } else {
                    a < range.end.0 && range.start.0 < z
                };
                if hit {
                    visit(&line, 0, index);
                }
                continue;
            }
            let a = display + row.display_at(block.source.start);
            let z = display + row.display_at(block.source.end);
            let hit = if range.start == range.end {
                a <= range.start.0
                    && (range.start.0 < z
                        || block.fence.as_ref().is_some_and(|fence| {
                            fence.body.start <= block.source.start
                                && block.source.start <= fence.body.end
                                && row.display_at(block.content.end) + display == range.start.0
                                && row.display_at(fence.body.end) + display == range.start.0
                        })
                        || (block.source.start == row.blocks.last().unwrap().source.start
                            && source + block.source.end
                                == self.rows.at(self.rows.len() - 1).1
                                    + self.rows.at(self.rows.len() - 1).0.source_len))
            } else {
                a < range.end.0 && range.start.0 < z
            };
            let empty_fence = block.fence.as_ref().is_some_and(|fence| {
                row.display_at(fence.body.start) == row.display_at(fence.body.end)
                    && block.source.start <= fence.whole.start
                    && fence.whole.start < block.source.end
                    && a == range.start.0
            });
            let format_endpoint = formatting
                && range.start != range.end
                && block.list.as_ref().is_some_and(|list| list.first)
                && display + row.display_at(block.content.start) == range.end.0;
            if hit || empty_fence || format_endpoint {
                // The synthetic end line of a nonfinal row belongs to its successor.
                if !block.source.is_empty()
                    || source + row.source_len
                        == self.rows.at(self.rows.len() - 1).1
                            + self.rows.at(self.rows.len() - 1).0.source_len
                {
                    visit(block, source, index);
                }
            }
        }
    }
}
