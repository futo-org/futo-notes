//! Find reads the visible display text; this module reports which of its line
//! breaks continue one paragraph (and so read as a space) versus separate blocks.
use super::Projection;
use crate::{DisplayOffset, DisplayRange};

impl Projection {
    /// Display ranges of line breaks inside a paragraph, in ascending order.
    /// Every other line break is a block boundary. One pass over retained rows;
    /// explicit find scans only, never the input path.
    pub(crate) fn soft_line_breaks(&self) -> Vec<DisplayRange> {
        let mut soft = Vec::new();
        let mut previous: Option<(&super::blocks::BlockLine, usize)> = None;
        for index in 0..self.rows.len() {
            let (row, _, display) = self.rows.at(index);
            for block in row.blocks.iter() {
                if let Some((before, end)) = previous {
                    let joined = before.paragraph_text
                        && block.paragraph_text
                        && before.source.end == block.source.start
                        && before.quote_depth == block.quote_depth
                        && !block.quote_start
                        && !block.list.as_ref().is_some_and(|list| list.first);
                    let start = display + row.display_at(block.content.start);
                    if joined && end < start {
                        soft.push(DisplayRange {
                            start: DisplayOffset(end),
                            end: DisplayOffset(start),
                        });
                    }
                }
                previous = Some((block, display + row.display_at(block.content.end)));
            }
        }
        soft
    }
}
