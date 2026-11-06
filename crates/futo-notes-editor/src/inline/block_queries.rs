//! Canonical retained block/list metadata and physical row queries.
use super::*;
mod visit;

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

    /// A caret needs the preceding sibling flag, not the full source ranges
    /// of a list's owner/items. Keep this bounded to its retained row.
    fn fix_previous_sibling(&self, index: usize, base: usize, list: &mut ListLine) {
        let row = self.rows.at(index).0;
        let first_line = row.blocks.first().map_or(0, |block| block.source.end);
        if list.quote_depth == 0
            && row.start_depth() == list.depth
            && list.item.start - base < first_line
            && list.previous_content_column.is_none()
        {
            list.previous_content_column = Some(list.content_column);
        }
    }

    /// Row-local attribution for a caret's toolbar. Expanding cut nested-list
    /// item or fence ranges here would make a typing refresh walk that region.
    pub(crate) fn caret_block_lines(&self, range: DisplayRange) -> Vec<blocks::BlockLine> {
        let mut result = Vec::new();
        self.visit_block_lines(range, true, |block, base, index| {
            let mut block = block.clone();
            block.shift(base);
            if let Some(list) = &mut block.list {
                self.fix_previous_sibling(index, base, list);
            }
            result.push(block);
        });
        result
    }

    /// A cut list keeps each row's own parse. Its ranges reaching across a
    /// cut come from the rows where they start and end, and a continued
    /// item's previous content column equals its own (the cut rule).
    pub(crate) fn fix_list(&self, index: usize, base: usize, list: &mut ListLine) {
        if list.quote_depth != 0 {
            return;
        }
        let row = self.rows.at(index).0;
        let depth = list.depth;
        let start_depth = row.start_depth();
        let next_depth = if index + 1 < self.rows.len() {
            self.rows.at(index + 1).0.start_depth()
        } else {
            0
        };
        if start_depth == 0 && next_depth == 0 {
            return;
        }
        let len = row.source_len;
        let at = |range: &std::ops::Range<usize>| range.start - base..range.end - base;
        let (owner, item, outer) = (at(&list.owner), at(&list.item), at(&list.outer_item));
        self.fix_previous_sibling(index, base, list);
        if continued_start(row, depth, owner.start) {
            list.owner.start = self.open_start(index, depth, false);
        }
        if next_depth >= depth && owner.end == len {
            list.owner.end = self.open_end(index, depth, false);
        }
        if start_depth > depth && item.start == 0 {
            list.item.start = self.open_start(index, depth, true);
        }
        if next_depth > depth && item.end == len {
            list.item.end = self.open_end(index, depth, true);
        }
        if depth == 1 {
            list.outer_item = list.item.clone();
            return;
        }
        if start_depth > 1 && outer.start == 0 {
            list.outer_item.start = self.open_start(index, 1, true);
        }
        if next_depth > 1 && outer.end == len {
            list.outer_item.end = self.open_end(index, 1, true);
        }
    }

    /// The start of the item (or list) at `depth` open across the start of
    /// row `index`: in the nearest earlier row where it starts.
    fn open_start(&self, mut index: usize, depth: usize, item: bool) -> usize {
        // A list spanning rows starts in the row its block starts at; a
        // staged first row's context starts before its text.
        if index == 0 {
            return 0;
        }
        if !item && depth == 1 {
            index = self.rows.block_start(index) + 1;
        }
        while index > 0 {
            index -= 1;
            let (row, base, _) = self.rows.at(index);
            let Some(&(item_start, owner_start)) = row.tail_chain.get(depth - 1) else {
                return base;
            };
            let continued = if item {
                row.start_depth() > depth && item_start == 0
            } else {
                continued_start(row, depth, owner_start)
            };
            if !continued {
                return base + if item { item_start } else { owner_start };
            }
        }
        0
    }

    /// The nested list context a window starting at source `start` is
    /// parsed after, when a row starting there continues a nested list: the
    /// row's context, its first item's number, and each context ancestor's
    /// item range and content column (depth 1 first).
    pub(crate) fn window_context(&self, start: usize) -> Option<WindowContext> {
        if start == 0 {
            return None;
        }
        let index = self.rows.locate(start, false);
        let index =
            (index..(index + 2).min(self.rows.len())).find(|&at| self.rows.at(at).1 == start)?;
        let row = self.rows.at(index).0;
        let context = row.context.clone()?;
        let ancestors = context
            .lines()
            .enumerate()
            .map(|(depth, line)| {
                let depth = depth + 1;
                let range =
                    self.open_start(index, depth, true)..self.open_end(index - 1, depth, true);
                // A restated ancestor line ends with its empty heading's `#`.
                (range, line.len() - 1)
            })
            .collect();
        Some(WindowContext {
            context,
            first_number: row.first_number(),
            ancestors,
        })
    }

    /// The end of the item (or list) at `depth` open across the end of row
    /// `index`: in the nearest later row where it ends.
    fn open_end(&self, mut index: usize, depth: usize, item: bool) -> usize {
        let last = self.rows.len() - 1;
        if !item && depth == 1 {
            index = self.rows.block_end(index).max(index + 1) - 1;
        }
        while index < last {
            index += 1;
            let (row, base, _) = self.rows.at(index);
            let end = if depth < row.start_depth() {
                let (item_end, owner_end) = row.context_ends[depth - 1];
                if item {
                    item_end
                } else {
                    owner_end
                }
            } else {
                row.blocks
                    .iter()
                    .find_map(|block| {
                        let list = block.list.as_ref()?;
                        (list.quote_depth == 0 && list.depth == depth).then_some(list.owner.end)
                    })
                    .unwrap_or(row.source_len)
            };
            let crosses = index < last && {
                let next = self.rows.at(index + 1).0.start_depth();
                next >= depth + usize::from(item)
            };
            if end < row.source_len || !crosses {
                return base + end;
            }
        }
        let (row, base, _) = self.rows.at(last);
        base + row.source_len
    }

    /// Shifted block lines whose cut list ranges stay row-local: only for
    /// readers of depth, number, check state and first-line role.
    pub(crate) fn view_block_lines(&self, range: DisplayRange) -> Vec<blocks::BlockLine> {
        self.collect_block_lines(range, false, |block, base, _| {
            let mut block = block.clone();
            block.shift(base);
            block
        })
    }

    pub(crate) fn block_lines(&self, range: DisplayRange) -> Vec<blocks::BlockLine> {
        self.collect_block_lines(range, false, |block, base, index| {
            self.fixed_block(block, base, index)
        })
    }

    /// Whether every block line [`Self::block_lines`] returns for `range`
    /// is code, without copying any of them.
    pub(crate) fn all_code_lines(&self, range: DisplayRange) -> bool {
        let mut all = true;
        self.visit_block_lines(range, false, |block, _, _| all &= block.code);
        all
    }

    pub(crate) fn format_block_lines(&self, range: DisplayRange) -> Vec<blocks::BlockLine> {
        self.collect_block_lines(range, true, |block, base, index| {
            self.fixed_block(block, base, index)
        })
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

    /// The row where the physical line holding row `index`'s start begins:
    /// word seams cut one line across several rows.
    pub(super) fn line_head(&self, mut index: usize) -> usize {
        while index > 0 && self.rows.at(index).0.mid_line {
            index -= 1;
        }
        index
    }

    /// Whether row `index`'s last block continues into the next row's first.
    pub(super) fn joins_next(&self, index: usize) -> bool {
        index + 1 < self.rows.len() && self.rows.at(index + 1).0.mid_line
    }

    /// Row `index`'s last block joined with the first block of each following
    /// row that starts inside its line at a word seam: the one physical line
    /// an uncut row holds, in absolute source coordinates. Also whether that
    /// line is its final row's last block.
    pub(super) fn joined_line(&self, index: usize) -> (blocks::BlockLine, usize, bool) {
        let (row, base, _) = self.rows.at(index);
        let mut line = row.blocks.last().expect("a row holds a block").clone();
        line.shift(base);
        let mut tail = index;
        let mut last_block = true;
        while last_block && self.joins_next(tail) {
            tail += 1;
            let (row, base, _) = self.rows.at(tail);
            let more = &row.blocks[0];
            line.source.end = base + more.source.end;
            line.content.end = base + more.content.end;
            if let (Some(body), Some(next)) = (line.bodies.last_mut(), more.bodies.first()) {
                body.source.end = base + next.source.end;
                body.content.end = base + next.content.end;
            }
            last_block = row.blocks.len() == 1;
        }
        (line, tail, last_block)
    }

    fn visit_indexed_source_blocks(
        &self,
        range: &std::ops::Range<usize>,
        mut visit: impl FnMut(&blocks::BlockLine, usize, usize),
    ) {
        if range.is_empty() {
            return;
        }
        let first = self.line_head(self.rows.locate(range.start, false));
        let last = self.rows.locate(range.end - 1, false);
        for index in first..=last {
            let (row, source, _) = self.rows.at(index);
            let joined = self.joins_next(index);
            let skip = usize::from(row.mid_line);
            let kept = row.blocks.len() - usize::from(joined);
            let begin = range.start.max(source) - source;
            let end = range.end.min(source + row.source_len) - source;
            if begin < end {
                let first = row
                    .blocks
                    .partition_point(|block| block.source.start < begin)
                    .saturating_sub(1)
                    .max(skip);
                let last = row
                    .blocks
                    .partition_point(|block| block.source.start < end)
                    .min(kept);
                for block in row.blocks.get(first..last).unwrap_or_default() {
                    if !block.empty_comment && begin < block.source.end && block.source.start < end
                    {
                        visit(block, source, index);
                    }
                }
            }
            if joined && kept >= skip {
                let (line, ..) = self.joined_line(index);
                if range.start < line.source.end && line.source.start < range.end {
                    visit(&line, 0, index);
                }
            }
        }
    }
}

/// Whether a list at `depth` starting at row-relative `start` continues from
/// an earlier row: it starts in the row's context, or it is the first item's
/// own list, which the cut rule continues.
fn continued_start(row: &super::row::Row, depth: usize, start: usize) -> bool {
    let start_depth = row.start_depth();
    let first_line = row.blocks.first().map_or(0, |block| block.source.end);
    start_depth > depth && start == 0 || start_depth == depth && start < first_line
}

/// What a staged window starting inside a nested list is parsed after.
pub(crate) struct WindowContext {
    pub context: std::sync::Arc<str>,
    pub first_number: Option<u64>,
    /// Each context ancestor's item range and content column.
    pub ancestors: Vec<(std::ops::Range<usize>, usize)>,
}
