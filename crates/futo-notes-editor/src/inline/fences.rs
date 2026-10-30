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
impl Fence {
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
            }
            _ => {}
        }
    }
}
