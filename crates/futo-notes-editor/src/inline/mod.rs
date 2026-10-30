mod block_edit;
pub(crate) mod blocks;
mod edit;
pub(crate) mod fences;
mod links;
mod row;
mod spelling;
mod toggle;
mod tree;

use crate::{
    Correspondence, DisplayOffset, DisplayRange, InlineFormat, ProjectionSlice, Revision,
    SemanticRun, SourceEdit, SourceOffset, SourceRange,
};
use ropey::Rope;
use row::{paragraphs, Row};
use tree::Rows;

pub(crate) struct Projection {
    pub display: Rope,
    pub rows: Rows,
    pub initial_parse_work: usize,
    pub literal_links: Vec<DisplayRange>,
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
        let initial_parse_work = source.len()
            + parsed
                .iter()
                .map(|row| row.parsed_source_bytes)
                .sum::<usize>();
        let mut display = Rope::new();
        for row in &parsed {
            display.append(Rope::from_str(&row.display));
        }
        let mut rows = Rows::default();
        rows.replace(0, 0, parsed);
        Self {
            display,
            rows,
            initial_parse_work,
            literal_links: Vec::new(),
        }
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
                code: block.code,
                language: block.code_language,
            })
            .collect();
        let links = self.link_descriptions(range);
        ProjectionSlice {
            links,
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

    pub(crate) fn block_lines(&self, range: DisplayRange) -> Vec<blocks::BlockLine> {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        let mut result = Vec::new();
        for index in first..=last {
            let (row, source, display) = self.rows.at(index);
            for block in &row.blocks {
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
                if hit || empty_fence {
                    let mut block = block.clone();
                    block.source.start += source;
                    block.source.end += source;
                    block.content.start += source;
                    block.content.end += source;
                    if let Some(fence) = &mut block.fence {
                        fence.shift(source);
                    }
                    for physical in block.bodies.iter_mut().chain(block.underline.iter_mut()) {
                        physical.source.start += source;
                        physical.source.end += source;
                        physical.content.start += source;
                        physical.content.end += source;
                    }
                    // The synthetic end line of a nonfinal row belongs to its successor.
                    if !block.source.is_empty()
                        || source + row.source_len
                            == self.rows.at(self.rows.len() - 1).1
                                + self.rows.at(self.rows.len() - 1).0.source_len
                    {
                        result.push(block);
                    }
                }
            }
        }
        result
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
        let parsed_source_bytes = text.len()
            + parsed
                .iter()
                .map(|row| row.parsed_source_bytes)
                .sum::<usize>();
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
        let removed = range.end.0 - range.start.0;
        let added = inserted.len();
        self.literal_links.retain_mut(|link| {
            if link.end.0 < range.start.0 {
                return true;
            }
            if link.start.0 > range.end.0 {
                link.start.0 = link.start.0 - removed + added;
                link.end.0 = link.end.0 - removed + added;
                return true;
            }
            if range.start.0 <= link.start.0 && link.end.0 <= range.end.0 && added == 0 {
                return false;
            }
            link.start.0 = link.start.0.min(range.start.0);
            link.end.0 = link.end.0.max(range.end.0) - removed + added;
            true
        });
        Update {
            range,
            inserted,
            parsed_source_bytes,
            materialized_source_bytes: text.len(),
            semantic_range,
        }
    }
}
