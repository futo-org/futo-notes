//! CommonMark supplies the code boundary. The source body remains opaque.
use super::blocks::BlockLine;
use pulldown_cmark::{CodeBlockKind, Event, Tag, TagEnd};
use std::ops::Range;

#[derive(Clone, Debug)]
pub(crate) struct Fence {
    pub whole: Range<usize>,
    pub body: Range<usize>,
    pub separator: Range<usize>,
    pub opener: Range<usize>,
    pub closer: Option<Range<usize>>,
    pub marker: u8,
    pub width: usize,
}
pub(crate) struct FenceInput {
    pub source: Range<usize>,
    pub continues_existing_row: bool,
}

impl Fence {
    /// Map only editable code endpoints. A selected physical ending retires
    /// its next row's hidden prefix; a caret or body-only selection does not.
    /// The terminal frame ending and closer never belong to the replacement.
    pub fn input_range(
        &self,
        projection: &super::Projection,
        range: crate::DisplayRange,
        touched: &[BlockLine],
        inserted: &str,
    ) -> Option<FenceInput> {
        let body_start = projection.display_at(self.body.start);
        let body_end = projection.display_at(self.body.end);
        if range.start.0 < body_start || body_end < range.end.0 {
            return None;
        }
        let start = if range.start.0 == body_end {
            self.body.end
        } else {
            projection.source_bounds(range.start.0).1
        };
        let mut end = if range.end.0 == body_end {
            self.body.end
        } else if range.start == range.end {
            start
        } else {
            projection.source_bounds(range.end.0).0
        };
        let mut continues_existing_row = false;
        if range.start != range.end {
            let left = projection.source_bounds(range.end.0).0;
            let endpoint = crate::DisplayRange {
                start: range.end,
                end: range.end,
            };
            for next in projection.block_lines(endpoint) {
                if next
                    .fence
                    .as_ref()
                    .is_some_and(|fence| fence.whole == self.whole)
                    && next.source.start == left
                    && next.content.start <= self.body.end
                    && touched.iter().any(|previous| {
                        previous.source.end == next.source.start
                            && previous.content.end < previous.source.end
                            && start <= previous.content.end
                    })
                {
                    continues_existing_row = inserted.ends_with('\n');
                    end = if continues_existing_row {
                        next.source.start
                    } else {
                        next.content.start
                    };
                    break;
                }
            }
        }
        (self.body.start <= start && start <= end && end <= self.body.end).then_some(FenceInput {
            source: start..end,
            continues_existing_row,
        })
    }

    pub fn shift(&mut self, by: usize) {
        for range in [
            &mut self.whole,
            &mut self.body,
            &mut self.opener,
            &mut self.separator,
        ] {
            range.start += by;
            range.end += by;
        }
        if let Some(range) = &mut self.closer {
            range.start += by;
            range.end += by;
        }
    }
}

pub(super) fn describe(
    source: &str,
    events: &[(Event<'_>, Range<usize>)],
    lines: &mut [BlockLine],
) {
    let mut code: Option<(Range<usize>, Option<String>, bool, Vec<Range<usize>>)> = None;
    for (event, range) in events {
        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                let (language, fenced) = match kind {
                    CodeBlockKind::Fenced(info) => {
                        (info.split_whitespace().next().map(str::to_owned), true)
                    }
                    CodeBlockKind::Indented => (None, false),
                };
                code = Some((range.clone(), language, fenced, Vec::new()));
            }
            Event::Text(_) if code.is_some() => code.as_mut().unwrap().3.push(range.clone()),
            Event::End(TagEnd::CodeBlock) => {
                let (whole, language, fenced, bodies) = code.take().unwrap();
                let first = lines.partition_point(|line| line.source.end <= whole.start);
                let last = lines.partition_point(|line| line.source.start < whole.end);
                let fence = if fenced {
                    let marker = source.as_bytes()[whole.start];
                    let width = source[whole.clone()]
                        .bytes()
                        .take_while(|&ch| ch == marker)
                        .count();
                    let opener = whole.start..whole.start + width;
                    let body_start = lines[first].source.end;
                    let final_line = &lines[last - 1];
                    let tail =
                        source[final_line.content.clone()].trim_start_matches([' ', '\t', '>']);
                    let close_width = tail.bytes().take_while(|&ch| ch == marker).count();
                    let closed = last > first + 1
                        && !bodies.iter().any(|body| {
                            body.start < final_line.source.end && final_line.source.start < body.end
                        })
                        && close_width >= width
                        && tail[close_width..].trim().is_empty();
                    let closer = closed.then(|| {
                        let start = final_line.content.end - tail.len();
                        start..start + close_width
                    });
                    let physical_end = if closed {
                        final_line.source.start
                    } else {
                        whole.end
                    };
                    // The final ending terminates code.value in the shipping
                    // CommonMark schema; preceding endings are editable text.
                    let ending = if source[body_start..physical_end].ends_with("\r\n") {
                        2
                    } else {
                        usize::from(source[body_start..physical_end].ends_with('\n'))
                    };
                    let body_end = physical_end - ending;
                    Some(Fence {
                        separator: body_end..physical_end,
                        whole: whole.clone(),
                        body: body_start..body_end,
                        opener,
                        closer,
                        marker,
                        width,
                    })
                } else {
                    None
                };
                for line in &mut lines[first..last] {
                    line.code = true;
                    line.code_language.clone_from(&language);
                    line.fence.clone_from(&fence);
                    let start = bodies
                        .iter()
                        .filter(|body| body.start < line.source.end && line.source.start < body.end)
                        .map(|body| body.start.max(line.source.start))
                        .min();
                    // Only a closer with following source supplies an inter-block
                    // break; its delimiter and the body frame ending stay hidden.
                    line.content = match start {
                        // A semantically empty row's Text event can begin at
                        // LF inside CRLF. Empty content ends before the entire
                        // physical ending; the parser-attributed prefix still
                        // includes any stripped fence indentation.
                        Some(start) if start > line.content.end => {
                            line.content.end..line.content.end
                        }
                        Some(start) => start..line.content.end,
                        None if fence.as_ref().is_some_and(|fence| {
                            line.source.end < source.len()
                                && fence.closer.as_ref().is_some_and(|close| {
                                    line.source.start <= close.start && close.end <= line.source.end
                                })
                        }) =>
                        {
                            line.content.end..line.content.end
                        }
                        None => line.source.end..line.source.end,
                    };
                    line.bodies[0].content = line.content.clone();
                }
                // An unmatched fence owns EOF, including the synthetic row
                // after its terminal ending. It must not introduce a foreign
                // prose owner at the editable body-end caret.
                if let Some(fence) =
                    fence.filter(|fence| fence.closer.is_none() && fence.whole.end == source.len())
                {
                    let depth = lines[last - 1].quote_depth;
                    if let Some(terminal) = lines
                        .get_mut(last)
                        .filter(|line| line.source.is_empty() && line.source.start == source.len())
                    {
                        terminal.code = true;
                        terminal.code_language.clone_from(&language);
                        terminal.quote_depth = depth;
                        terminal.fence = Some(fence);
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
#[path = "fences_promotion_tests.rs"]
mod promotion_tests;
