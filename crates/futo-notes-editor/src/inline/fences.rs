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
    /// Fixed machine words copied when cloning the retained fence record.
    pub const COPY_WORK: usize = std::mem::size_of::<Self>() / std::mem::size_of::<usize>();

    /// Complete body ownership plus text outside it retires a closed frame.
    /// Resolve cut records through the same canonical owner as block queries.
    pub fn retired_by(
        &self,
        projection: &super::Projection,
        index: usize,
        source_base: usize,
        range: crate::DisplayRange,
    ) -> (bool, usize) {
        let mut frame = self.clone();
        frame.shift(source_base);
        let fixed = projection.fix_fence_with_work(index, source_base, &mut frame);
        let (start, a) = projection.display_at_with_work(frame.body.start);
        let (end, z) = projection.display_at_with_work(frame.body.end);
        (
            frame.closer.is_some()
                && range.start.0 <= start
                && end <= range.end.0
                && (range.start.0 < start || end < range.end.0),
            Self::COPY_WORK + fixed + a + z,
        )
    }

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

    /// Rebase onto a row that starts `by` bytes later; ranges before it
    /// (a continued fence's opener) collapse to the row start.
    pub fn back(&mut self, by: usize) {
        let back = |range: &mut Range<usize>| {
            *range = range.start.max(by) - by..range.end.max(by) - by;
        };
        for range in [
            &mut self.whole,
            &mut self.body,
            &mut self.opener,
            &mut self.separator,
        ] {
            back(range);
        }
        if let Some(range) = &mut self.closer {
            back(range);
        }
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

/// Whether a continued row's opener line opens a fence rather than HTML.
pub(crate) fn is_opener(line: &str) -> bool {
    line.trim_start_matches(' ').starts_with(['`', '~'])
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
                            if body.start < final_line.source.end {
                                final_line.source.start < body.end
                            } else {
                                false
                            }
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
                    let start = body_start(&bodies, &line.source);
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

/// The minimum source start among body ranges with the original strict overlap
/// predicate. Empty physical query rows retain that same predicate.
fn body_start(bodies: &[Range<usize>], line: &Range<usize>) -> Option<usize> {
    // Canonical Text ranges have monotonic starts and ends. Earlier endings
    // cannot overlap; among the remaining ranges the first overlapping start
    // supplies the old minimum, even for duplicates or overlapping bodies.
    let first = bodies.partition_point(|body| body.end <= line.start);
    let body = bodies.get(first)?;
    if body.start >= line.end {
        return None;
    }
    if line.start >= body.end {
        return None;
    }
    Some(body.start.max(line.start))
}

impl super::Projection {
    /// The same retained frame facts used by ordinary replacement. Inspect
    /// physical records as well as visible ones: an empty terminal body can
    /// share the selection's endpoint while its opener remains hidden.
    pub(crate) fn retires_fence(&self, range: crate::DisplayRange) -> (bool, usize) {
        if range.start == range.end {
            return (false, 0);
        }
        let (first, a) = self.rows.locate_with_work(range.start.0, true);
        let (last, z) = self.rows.locate_with_work(range.end.0, true);
        let mut work = a + z;
        for index in first..=last {
            let (row, source, _, visits) = self.rows.at_with_work(index);
            work += visits;
            for block in &row.blocks {
                work += 1;
                if let Some(fence) = &block.fence {
                    let (retired, visits) = fence.retired_by(self, index, source, range);
                    work += visits;
                    if retired {
                        return (true, work);
                    }
                }
            }
        }
        (false, work)
    }
}
