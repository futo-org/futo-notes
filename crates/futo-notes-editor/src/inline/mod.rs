mod block_edit;
pub(crate) mod blocks;
mod edit;
mod empty_comments;
pub(crate) mod fences;
mod lists;
mod row;
mod spelling;
mod toggle;
mod tree;

use crate::{
    Correspondence, DisplayOffset, DisplayRange, InlineFormat, ProjectionSlice, Revision,
    SemanticRun, SourceEdit, SourceOffset, SourceRange,
};
pub(crate) use lists::{columns, visit_container, ListLine};
#[cfg(test)]
pub(crate) use lists::{
    CONTAINER_LIFT_ITEM_SCANS, CONTAINER_METADATA_VISITS, CONTAINER_PREFIX_QUERIES,
    CONTAINER_STYLE_OWNER_SCANS,
};
use ropey::Rope;
use row::{paragraphs, Row};
pub(crate) use tree::ContextWitness;
use tree::Rows;
#[cfg(test)]
pub(crate) use tree::CONTEXT_VISITS;

pub(crate) struct Projection {
    pub display: Rope,
    pub rows: Rows,
}

pub(crate) struct Update {
    pub range: DisplayRange,
    pub inserted: String,
    pub parsed_source_bytes: usize,
    pub materialized_source_bytes: usize,
    pub semantic_range: DisplayRange,
}

impl Projection {
    pub fn new(source: &str) -> Self {
        let parsed: Vec<_> = paragraphs(source).into_iter().map(Row::parse).collect();
        let mut display = Rope::new();
        for row in &parsed {
            display.append(Rope::from_str(&row.display));
        }
        let mut rows = Rows::default();
        rows.replace(0, 0, parsed);
        Self { display, rows }
    }

    /// Whole paragraph context for an explicit compound action. Ordinary typing
    /// never constructs this temporary session or materializes this envelope.
    pub fn edit_window(&self, range: DisplayRange) -> (std::ops::Range<usize>, usize) {
        let first = self.rows.locate(range.start.0, true).saturating_sub(1);
        let last = (self.rows.locate(range.end.0, true) + 1).min(self.rows.len() - 1);
        let (_, source_start, display_start) = self.rows.at(first);
        let (row, source_end, _) = self.rows.at(last);
        (source_start..source_end + row.source_len, display_start)
    }

    pub fn source_bounds(&self, offset: usize) -> (usize, usize) {
        let (row, source, display) = self.rows.at(self.rows.locate(offset, true));
        let (low, high) = row.source_bounds(offset - display);
        (source + low, source + high)
    }

    pub fn display_at(&self, offset: usize) -> usize {
        let (row, source, display) = self.rows.at(self.rows.locate(offset, false));
        display + row.display_at(offset - source)
    }

    pub fn formats_at(&self, offset: usize) -> Vec<InlineFormat> {
        let (row, source, _) = self.rows.at(self.rows.locate(offset, false));
        row.formats_at(offset - source)
    }

    pub fn query(&self, revision: Revision, range: DisplayRange) -> ProjectionSlice {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        let mut runs: Vec<SemanticRun> = Vec::new();
        let mut correspondence: Vec<Correspondence> = Vec::new();
        for index in first..=last {
            let (row, source, display) = self.rows.at(index);
            for segment in &row.segments {
                let start = display + segment.display.start;
                let end = display + segment.display.end;
                if start > range.end.0 || end < range.start.0 {
                    continue;
                }
                let mapped = Correspondence {
                    source: SourceRange {
                        start: SourceOffset(source + segment.source.start),
                        end: SourceOffset(source + segment.source.end),
                    },
                    display: DisplayRange {
                        start: DisplayOffset(start),
                        end: DisplayOffset(end),
                    },
                };
                if let Some(previous) = correspondence.last_mut() {
                    if previous.display.start == previous.display.end
                        && mapped.display == previous.display
                        && previous.source.end == mapped.source.start
                    {
                        previous.source.end = mapped.source.end;
                    } else {
                        correspondence.push(mapped);
                    }
                } else {
                    correspondence.push(mapped);
                }
                if start == end || start >= range.end.0 || end <= range.start.0 {
                    continue;
                }
                let mut formats = row.formats_at(segment.source.start);
                formats.sort();
                formats.dedup();
                let selected = DisplayRange {
                    start: DisplayOffset(start.max(range.start.0)),
                    end: DisplayOffset(end.min(range.end.0)),
                };
                if let Some(previous) = runs.last_mut() {
                    if previous.range.end == selected.start && previous.formats == formats {
                        previous.range.end = selected.end;
                        continue;
                    }
                }
                runs.push(SemanticRun {
                    range: selected,
                    formats,
                });
            }
        }
        let blocks = self
            .block_lines(range)
            .into_iter()
            .map(|block| crate::BlockDescription {
                range: DisplayRange {
                    start: DisplayOffset(self.display_at(block.content.start)),
                    end: DisplayOffset(self.display_at(block.content.end)),
                },
                heading: block.heading,
                quote_depth: block.quote_depth,
                divider: block.divider,
                list: block.list.as_ref().map(|list| crate::ListDescription {
                    depth: list.depth,
                    number: list.ordinal,
                    checked: list.checked,
                    first: list.first,
                }),
                code: block.code,
                language: block.code_language,
            })
            .collect();
        ProjectionSlice {
            blocks,
            revision,
            range,
            text: self
                .display
                .byte_slice(range.start.0..range.end.0)
                .to_string(),
            runs,
            correspondence,
        }
    }

    /// Command-local canonical metadata from the original retained row. The
    /// returned byte count charges both source materialization and parser input.
    pub(crate) fn list_items_at(
        &self,
        source: &Rope,
        at: usize,
    ) -> (Vec<ListLine>, usize, std::ops::Range<usize>) {
        let (row, base, _) = self.rows.at(self.rows.locate(at, false));
        let raw = source.byte_slice(base..base + row.source_len).to_string();
        let events = row::source_events(&raw);
        let mut items = lists::describe(&raw, &events).into_items();
        for item in &mut items {
            visit_container();
            item.shift(base);
        }
        // Command-local event records are queried by original source range.
        items.sort_by_key(|item| {
            visit_container();
            item.marker.start
        });
        (items, raw.len(), base..base + row.source_len)
    }

    fn block_ref_at_source(&self, at: usize) -> Option<(&blocks::BlockLine, usize)> {
        let (row, base, _) = self.rows.at(self.rows.locate(at, false));
        let local = at - base;
        let index = row
            .blocks
            .partition_point(|block| {
                visit_container();
                block.source.start <= local
            })
            .saturating_sub(1);
        Some((row.blocks.get(index)?, base))
    }

    pub(crate) fn list_command_line_at_source(&self, at: usize) -> Option<blocks::ListCommandLine> {
        let (block, base) = self.block_ref_at_source(at)?;
        Some(blocks::ListCommandLine::from_block(block, base))
    }

    pub(crate) fn block_at_source(&self, at: usize) -> Option<blocks::BlockLine> {
        let (block, base) = self.block_ref_at_source(at)?;
        let mut block = block.clone();
        block.shift(base);
        Some(block)
    }

    pub(crate) fn source_prefix_at(&self, at: usize) -> Option<blocks::SourcePrefix> {
        #[cfg(test)]
        CONTAINER_PREFIX_QUERIES.with(|count| count.set(count.get() + 1));
        let (block, base) = self.block_ref_at_source(at)?;
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
        self.visit_block_lines(range, false, |block, base| {
            let mut block = block.clone();
            block.shift(base);
            result.push(block);
        });
        result
    }

    pub(crate) fn format_block_lines(&self, range: DisplayRange) -> Vec<blocks::BlockLine> {
        let mut result = Vec::new();
        self.visit_block_lines(range, true, |block, base| {
            let mut block = block.clone();
            block.shift(base);
            result.push(block);
        });
        result
    }

    pub(crate) fn list_command_lines(&self, range: DisplayRange) -> Vec<blocks::ListCommandLine> {
        let mut result = Vec::new();
        self.visit_block_lines(range, true, |block, base| {
            result.push(blocks::ListCommandLine::from_block(block, base))
        });
        result
    }

    fn visit_block_lines(
        &self,
        range: DisplayRange,
        formatting: bool,
        mut visit: impl FnMut(&blocks::BlockLine, usize),
    ) {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        for index in first..=last {
            let (row, source, display) = self.rows.at(index);
            for block in &row.blocks {
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
                        visit(block, source);
                    }
                }
            }
        }
    }

    /// Reparse the edit's paragraphs and immediate neighbors, which can join
    /// when a blank-line separator changes. No tail offsets are rewritten.
    pub fn apply(&mut self, source: &Rope, edit: &SourceEdit) -> Update {
        let first = self
            .rows
            .locate(edit.range.start.0, false)
            .saturating_sub(1);
        let last = (self.rows.locate(edit.range.end.0, false) + 1).min(self.rows.len() - 1);
        let (_, source_start, display_start) = self.rows.at(first);
        let (row, old_end, display_end) = self.rows.at(last);
        let source_end = old_end + row.source_len - edit.removed.len() + edit.inserted.len();
        let display_end = display_end + row.display.len();
        let text = source.byte_slice(source_start..source_end).to_string();
        let parsed: Vec<_> = paragraphs(&text).into_iter().map(Row::parse).collect();
        let mut inserted = String::new();
        for row in &parsed {
            inserted.push_str(&row.display);
        }
        let parsed_display_len = inserted.len();
        let old = self
            .display
            .byte_slice(display_start..display_end)
            .to_string();
        let start = self.display.byte_to_char(display_start);
        let end = self.display.byte_to_char(display_end);
        self.display.remove(start..end);
        self.display.insert(start, &inserted);
        self.rows.replace(first, last + 1, parsed);
        let prefix: usize = old
            .chars()
            .zip(inserted.chars())
            .take_while(|(a, b)| a == b)
            .map(|(c, _)| c.len_utf8())
            .sum();
        let suffix: usize = old[prefix..]
            .chars()
            .rev()
            .zip(inserted[prefix..].chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(c, _)| c.len_utf8())
            .sum();
        let range = DisplayRange {
            start: DisplayOffset(display_start + prefix),
            end: DisplayOffset(display_end - suffix),
        };
        let inserted = inserted[prefix..inserted.len() - suffix].to_owned();
        let semantic_range = DisplayRange {
            start: DisplayOffset(display_start),
            end: DisplayOffset(display_start + parsed_display_len),
        };
        Update {
            range,
            inserted,
            parsed_source_bytes: 2 * text.len(),
            materialized_source_bytes: text.len(),
            semantic_range,
        }
    }
}
