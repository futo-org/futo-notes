//! Canonical retained block/list metadata and physical row queries.
use super::*;

impl Projection {
    /// Command-local canonical metadata from the original retained row. The
    /// returned byte count charges both source materialization and parser input.
    pub(crate) fn list_items_at(
        &self,
        source: &Rope,
        at: usize,
    ) -> (Vec<ListLine>, usize, std::ops::Range<usize>) {
        let (items, work, window, _) = self.list_items_and_paragraph_at(source, at, None);
        (items, work, window)
    }

    /// The optional textblock is temporary command metadata from the same
    /// canonical row/events as item ownership, never a naked body reparse.
    pub(crate) fn list_items_and_paragraph_at(
        &self,
        source: &Rope,
        at: usize,
        body: Option<usize>,
    ) -> (
        Vec<ListLine>,
        usize,
        std::ops::Range<usize>,
        Option<std::ops::Range<usize>>,
    ) {
        let index = self.rows.locate(at, false);
        let (row, base, _) = self.rows.at(index);
        let raw = source.byte_slice(base..base + row.source_len).to_string();
        let events = row::source_events(&raw);
        let paragraph = body.and_then(|body| {
            let textblock = blocks_paragraph::at(&events, at - base, body.checked_sub(base)?)?;
            let mut end = base + textblock.source.end;
            if !textblock.source.is_empty() {
                let physical = source.line_to_byte(source.byte_to_line(end - 1));
                let row = self.source_prefix_at(physical)?;
                if row.source.end <= base + textblock.boundary {
                    end = row.source.end;
                }
            }
            Some(base + textblock.source.start..end)
        });
        let mut items = lists::describe(&raw, &events).into_items();
        for item in &mut items {
            visit_container();
            item.shift(base);
            self.fix_list(index, base, item);
        }
        // Command-local event records are queried by original source range.
        items.sort_by_key(|item| {
            visit_container();
            item.marker.start
        });
        (items, raw.len(), base..base + row.source_len, paragraph)
    }

    pub(crate) fn block_ref_at_source(&self, at: usize) -> Option<(&blocks::BlockLine, usize)> {
        self.indexed_block_at_source(at)
            .map(|(block, base, _)| (block, base))
    }

    fn indexed_block_at_source(&self, at: usize) -> Option<(&blocks::BlockLine, usize, usize)> {
        let index = self.rows.locate(at, false);
        let (row, base, _) = self.rows.at(index);
        let local = at - base;
        let block = row
            .blocks
            .partition_point(|block| {
                visit_container();
                block.source.start <= local
            })
            .saturating_sub(1);
        Some((row.blocks.get(block)?, base, index))
    }

    pub(crate) fn list_command_line_at_source(&self, at: usize) -> Option<blocks::ListCommandLine> {
        let (block, base, index) = self.indexed_block_at_source(at)?;
        Some(self.command_line(block, base, index))
    }

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

    /// The retained semantic neighbor, with a cut list's list-wide fields.
    pub(crate) fn context_neighbor(
        &self,
        at: usize,
        forward: bool,
        quote: usize,
    ) -> Option<ContextWitness> {
        let mut witness = self.rows.context_neighbor(at, forward, quote)?;
        if let Some(list) = &mut witness.list {
            let index = self.rows.locate(witness.source.start, false);
            let base = self.rows.at(index).1;
            self.fix_list(index, base, list);
        }
        Some(witness)
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
            visit_container();
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

    pub(crate) fn source_prefix_at(&self, at: usize) -> Option<blocks::SourcePrefix> {
        #[cfg(test)]
        CONTAINER_PREFIX_QUERIES.with(|count| count.set(count.get() + 1));
        let (block, base, row_index) = self.indexed_block_at_source(at)?;
        let local = at - base;
        let index = block
            .bodies
            .partition_point(|body| {
                visit_container();
                body.source.start <= local
            })
            .saturating_sub(1);
        let body = block.bodies.get(index)?;
        if body.source.start != local {
            return None;
        }
        let mut end = body.content.start;
        if let Some(fence) = &block.fence {
            for marker in std::iter::once(&fence.opener).chain(fence.closer.iter()) {
                if body.source.start <= marker.start && marker.start < body.source.end {
                    end = end.min(marker.start);
                }
            }
        }
        let mut list = block.list.clone();
        if let Some(list) = &mut list {
            list.shift(base);
            self.fix_list(row_index, base, list);
        }
        Some(blocks::SourcePrefix {
            source: base + body.source.start..base + body.source.end,
            prefix: base + body.source.start..base + end,
            content: base + body.content.start..base + body.content.end,
            quote_depth: block.quote_depth,
            code: block.code,
            list,
        })
    }

    pub(crate) fn block_is_code(&self, at: usize) -> bool {
        self.block_ref_at_source(at)
            .is_some_and(|(block, _)| block.code)
    }

    pub(crate) fn block_lines(&self, range: DisplayRange) -> Vec<blocks::BlockLine> {
        let mut result = Vec::new();
        self.visit_block_lines(range, false, |block, base, index| {
            let mut block = block.clone();
            block.shift(base);
            if let Some(list) = &mut block.list {
                self.fix_list(index, base, list);
            }
            result.push(block);
        });
        result
    }

    pub(crate) fn format_block_lines(&self, range: DisplayRange) -> Vec<blocks::BlockLine> {
        let mut result = Vec::new();
        self.visit_block_lines(range, true, |block, base, index| {
            let mut block = block.clone();
            block.shift(base);
            if let Some(list) = &mut block.list {
                self.fix_list(index, base, list);
            }
            result.push(block);
        });
        result
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

    /// Borrow original canonical metadata once in a bounded source window.
    /// Bodies and language strings remain in their retained row.
    pub(crate) fn visit_source_blocks<'a>(
        &'a self,
        range: &std::ops::Range<usize>,
        mut visit: impl FnMut(&'a blocks::BlockLine, usize),
    ) {
        self.visit_indexed_source_blocks(range, |block, base, _| visit(block, base));
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
                .partition_point(|block| {
                    visit_container();
                    block.source.start < begin
                })
                .saturating_sub(1);
            let last = row.blocks.partition_point(|block| {
                visit_container();
                block.source.start < end
            });
            for block in &row.blocks[first..last] {
                #[cfg(test)]
                CONTAINER_BLOCK_QUERY_VISITS.with(|count| count.set(count.get() + 1));
                visit_container();
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
                #[cfg(test)]
                CONTAINER_BLOCK_QUERY_VISITS.with(|count| count.set(count.get() + 1));
                visit_container();
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
