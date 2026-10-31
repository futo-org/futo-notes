//! Retained canonical proof for the first bounded opaque-code input slice.
use super::*;
use std::ops::Range;

pub(crate) struct RetainedCode {
    pub body: Range<usize>,
    pub display: Range<usize>,
    pub whole: Range<usize>,
    pub language: Option<String>,
}

impl Projection {
    /// Explicit entry preparation may inspect a whole retained row. Subsequent
    /// code keys use this proof, never equal source/display bytes as provenance.
    pub(crate) fn retain_bounded_code(
        &self,
        at: DisplayOffset,
    ) -> Option<(RetainedCode, usize, usize)> {
        let (row, source, display, mut visits) = self.rows.display_row_with_work(at.0);
        for block in &row.blocks {
            visits += 1;
            let Some(fence) = &block.fence else { continue };
            if block.quote_depth != 0 || block.in_list || block.list.is_some() {
                continue;
            }
            let opener = row.blocks.iter().find(|line| {
                visits += 1;
                line.source.start <= fence.opener.start && fence.opener.end <= line.source.end
            })?;
            if opener.source.start != fence.opener.start
                || fence.body.is_empty()
                || fence.closer.is_none()
            {
                continue;
            }
            let start = row.display_at_with_work(fence.body.start);
            let end = row.display_at_with_work(fence.body.end);
            visits += start.1 + end.1;
            if at.0 < display + start.0 || display + end.0 < at.0 {
                continue;
            }
            // A large copied language would itself defeat a local result bound.
            if block
                .code_language
                .as_ref()
                .is_some_and(|language| language.len() > 256)
            {
                return None;
            }
            let mut covered_source = fence.body.start;
            let mut covered_display = start.0;
            for segment in &row.segments {
                visits += 1;
                let begin = segment.source.start.max(fence.body.start);
                let finish = segment.source.end.min(fence.body.end);
                if begin >= finish {
                    continue;
                }
                if !segment.identity
                    || begin != covered_source
                    || segment.display.start + begin - segment.source.start != covered_display
                {
                    return None;
                }
                covered_source = finish;
                covered_display += finish - begin;
            }
            if covered_source != fence.body.end || covered_display != end.0 {
                return None;
            }
            return Some((
                RetainedCode {
                    body: source + fence.body.start..source + fence.body.end,
                    display: display + start.0..display + end.0,
                    whole: source + fence.whole.start..source + fence.whole.end,
                    language: block.code_language.clone(),
                },
                visits,
                block.code_language.as_ref().map_or(0, String::len),
            ));
        }
        None
    }
}
