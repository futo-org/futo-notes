//! Canonical retained block/list metadata and physical row queries.
use super::*;

impl Projection {
    fn command_line(
        &self,
        block: &blocks::BlockLine,
        base: usize,
        index: usize,
    ) -> blocks::ListCommandLine {
        let mut line = blocks::ListCommandLine::from_block(block, base);
        if let Some(list) = &mut line.list {
            self.fix_list(index, base, list);
        }
        line
    }

    /// A cut list keeps each row's own parse. Its list-wide owner and the
    /// first continued item's previous content column (equal by the cut rule)
    /// come from the rows where the list starts and ends.
    pub(crate) fn fix_list(&self, index: usize, base: usize, list: &mut ListLine) {
        if list.depth != 1 || list.quote_depth != 0 {
            return;
        }
        let row = self.rows.at(index).0;
        let continued = row.continues
            && row.opener.is_none()
            && row.blocks.first().is_some_and(|block| {
                block.list.as_ref().is_some_and(|first| {
                    first.quote_depth == 0 && first.outer_item.start == list.owner.start - base
                })
            });
        let continues_on = list.owner.end - base == row.source_len
            && index + 1 < self.rows.len()
            && self.rows.at(index + 1).0.continues
            && self.rows.at(index + 1).0.opener.is_none();
        if !continued && !continues_on {
            return;
        }
        let top = |block: &blocks::BlockLine| {
            block
                .list
                .as_ref()
                .filter(|list| list.depth == 1 && list.quote_depth == 0)
                .map(|list| list.owner.clone())
        };
        if continued {
            if list.item.start == list.owner.start && list.previous_content_column.is_none() {
                list.previous_content_column = Some(list.content_column);
            }
            let (head, head_base, _) = self.rows.at(self.rows.block_start(index));
            if let Some(owner) = head.blocks.iter().rev().find_map(top) {
                list.owner.start = head_base + owner.start;
            }
        }
        if continues_on {
            let (tail, tail_base, _) = self.rows.at(self.rows.block_end(index));
            if let Some(owner) = tail.blocks.iter().find_map(top) {
                list.owner.end = tail_base + owner.end;
            }
        }
    }

    pub(crate) fn block_lines(&self, range: DisplayRange) -> Vec<blocks::BlockLine> {
        let mut result = Vec::new();
        self.visit_block_lines(range, false, |block, base, index| {
            result.push(self.fixed_block(block, base, index));
        });
        result
    }

    pub(crate) fn format_block_lines(&self, range: DisplayRange) -> Vec<blocks::BlockLine> {
        let mut result = Vec::new();
        self.visit_block_lines(range, true, |block, base, index| {
            result.push(self.fixed_block(block, base, index));
        });
        result
    }

    /// A shifted copy with a cut list's and cut fence's block-wide fields.
    fn fixed_block(
        &self,
        block: &blocks::BlockLine,
        base: usize,
        index: usize,
    ) -> blocks::BlockLine {
        let mut block = block.clone();
        block.shift(base);
        if let Some(list) = &mut block.list {
            self.fix_list(index, base, list);
        }
        if let Some(fence) = &mut block.fence {
            self.fix_fence(index, base, fence);
        }
        block
    }

    /// A cut fence keeps each row's own parse. Its opener and body start
    /// come from the row where it starts; its body end, frame and closer from
    /// the row where it ends (#314).
    pub(crate) fn fix_fence(&self, index: usize, base: usize, fence: &mut fences::Fence) {
        let row = self.rows.at(index).0;
        let continued = fence.whole.start == base
            && row.continues
            && row.opener.as_deref().is_some_and(fences::is_opener);
        let continues_on = fence.closer.is_none()
            && fence.whole.end == base + row.source_len
            && index + 1 < self.rows.len()
            && self.rows.at(index + 1).0.continues
            && self.rows.at(index + 1).0.opener.is_some();
        let found = |at: usize, last: bool| {
            let (row, base, _) = self.rows.at(at);
            let mut blocks = row.blocks.iter();
            let block = if last {
                blocks.rev().find(|block| block.fence.is_some())
            } else {
                blocks.find(|block| block.fence.is_some())
            };
            let mut fence = block?.fence.clone()?;
            fence.shift(base);
            Some(fence)
        };
        if continued {
            if let Some(head) = found(self.rows.block_start(index), true) {
                fence.whole.start = head.whole.start;
                fence.opener = head.opener;
                fence.body.start = head.body.start;
            }
        }
        if continues_on {
            if let Some(tail) = found(self.rows.block_end(index), false) {
                fence.whole.end = tail.whole.end;
                fence.body.end = tail.body.end;
                fence.separator = tail.separator;
                fence.closer = tail.closer;
            }
        }
    }

    pub(crate) fn list_command_lines(&self, range: DisplayRange) -> Vec<blocks::ListCommandLine> {
        let mut result = Vec::new();
        self.visit_block_lines(range, true, |block, base, index| {
            result.push(self.command_line(block, base, index))
        });
        result
    }

    /// Fixed records in a canonical item/owner source window. Hidden prefixes
    /// are source ownership, so expansion need not round-trip through display.
    pub(crate) fn list_command_lines_in_source(
        &self,
        range: &std::ops::Range<usize>,
    ) -> Vec<blocks::ListCommandLine> {
        let mut result = Vec::new();
        self.visit_indexed_source_blocks(range, |block, base, index| {
            result.push(self.command_line(block, base, index));
        });
        result
    }

    fn visit_indexed_source_blocks<'a>(
        &'a self,
        range: &std::ops::Range<usize>,
        mut visit: impl FnMut(&'a blocks::BlockLine, usize, usize),
    ) {
        if range.is_empty() {
            return;
        }
        let first = self.rows.locate(range.start, false);
        let last = self.rows.locate(range.end - 1, false);
        for index in first..=last {
            let (row, source, _) = self.rows.at(index);
            let begin = range.start.max(source) - source;
            let end = range.end.min(source + row.source_len) - source;
            if begin >= end {
                continue;
            }
            let first = row
                .blocks
                .partition_point(|block| block.source.start < begin)
                .saturating_sub(1);
            let last = row.blocks.partition_point(|block| block.source.start < end);
            for block in &row.blocks[first..last] {
                if !block.empty_comment && begin < block.source.end && block.source.start < end {
                    visit(block, source, index);
                }
            }
        }
    }

    fn visit_block_lines(
        &self,
        range: DisplayRange,
        formatting: bool,
        mut visit: impl FnMut(&blocks::BlockLine, usize, usize),
    ) {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        for index in first..=last {
            let (row, source, display) = self.rows.at(index);
            for block in &row.blocks {
                if block.empty_comment {
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
}
