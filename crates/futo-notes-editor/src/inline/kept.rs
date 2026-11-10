//! Whether an input's whole result shows what it promised and leaves every
//! line outside it as it was: the check an input that repaired a code
//! block's frame passes before the host accepts it (`edit::Repair`).
use super::Projection;
use crate::{DisplayOffset, DisplayRange};
use pulldown_cmark::{Event, Parser, Tag};
use std::ops::Range;

/// What an input shows in place of the display it was given, in that
/// display's coordinates.
pub(crate) enum Expected {
    /// Each range replaced by its text.
    Replaced(Vec<(Range<usize>, String)>),
    /// Enter over a range: one line break, LF or CRLF.
    Enter(Range<usize>),
    /// Backspace (`false`) or Delete (`true`): the selection removed, or at
    /// a caret one span ending or starting there.
    Deleted(Range<usize>, bool),
    /// Pasted Markdown: shown as Markdown, or as its text where it lands in
    /// code, with pasted line endings spelled either way.
    Pasted(Range<usize>, String),
}

/// A shown line: what block it is in, whether it starts that block, and its
/// source line.
#[derive(Clone, PartialEq)]
struct Line {
    code: bool,
    heading: u8,
    quote: usize,
    list: Option<usize>,
    in_list: bool,
    html: bool,
    starts: bool,
    source: String,
}

/// Whether `after`, which an input turned `before` into, shows `before`'s
/// display with `expected` in place, and every nonblank line before the
/// first changed line and after the last is the same `Line`, except that
/// the first line after may now start its block (the rest of a paragraph the
/// input cut stays a paragraph).
pub(crate) fn keeps_blocks(before: &str, after: &str, expected: &Expected) -> bool {
    let (old, old_lines) = read(before);
    let (new, new_lines) = read(after);
    let Some((a, b)) = shown(&old, &new, expected) else {
        return false;
    };
    let first = old[..a].matches('\n').count();
    let last = old[..b].matches('\n').count();
    let before: Vec<_> = old_lines.iter().filter(|line| line.0 < first).collect();
    let after: Vec<_> = old_lines.iter().filter(|line| line.0 > last).collect();
    before.len() + after.len() <= new_lines.len()
        && before
            .iter()
            .zip(&new_lines)
            .all(|(old, new)| old.1 == new.1)
        && after
            .iter()
            .rev()
            .zip(new_lines.iter().rev())
            .enumerate()
            .all(|(from_end, (old, new))| {
                let split = from_end + 1 == after.len() && !old.1.starts && new.1.starts;
                old.1 == new.1
                    || split
                        && Line {
                            starts: true,
                            ..old.1.clone()
                        } == new.1
            })
}

/// The old display span the input replaced, when `new` shows it as expected.
fn shown(old: &str, new: &str, expected: &Expected) -> Option<(usize, usize)> {
    let one = |range: &Range<usize>, text: &str| -> Option<String> {
        Some(format!(
            "{}{text}{}",
            old.get(..range.start)?,
            old.get(range.end..)?
        ))
    };
    match expected {
        Expected::Replaced(runs) => {
            let mut shown = String::new();
            let mut at = 0;
            for (range, text) in runs {
                shown.push_str(old.get(at..range.start)?);
                shown.push_str(text);
                at = range.end;
            }
            shown.push_str(old.get(at..)?);
            let span = (runs.first()?.0.start, runs.last()?.0.end);
            (shown == new).then_some(span)
        }
        Expected::Enter(range) => ["\n", "\r\n"]
            .iter()
            .any(|text| one(range, text).as_deref() == Some(new))
            .then_some((range.start, range.end)),
        Expected::Deleted(range, forward) => {
            let gone = old.len().checked_sub(new.len())?;
            let range = match (range.is_empty(), forward) {
                (false, _) => range.clone(),
                (true, false) => range.start.checked_sub(gone)?..range.start,
                (true, true) => range.start..range.start + gone,
            };
            (one(&range, "").as_deref() == Some(new)).then_some((range.start, range.end))
        }
        Expected::Pasted(range, text) => {
            let (head, tail) = (old.get(..range.start)?, old.get(range.end..)?);
            let middle = new.strip_prefix(head)?.strip_suffix(tail)?;
            let lf = |text: &str| text.replace("\r\n", "\n");
            let text = lf(text);
            let text = text.strip_suffix('\n').unwrap_or(&text);
            let markdown = Projection::new(text).display.to_string();
            [text, markdown.as_str()]
                .contains(&lf(middle).as_str())
                .then_some((range.start, range.end))
        }
    }
}

/// `source`'s display and each nonblank shown line's index and `Line`.
fn read(source: &str) -> (String, Vec<(usize, Line)>) {
    let projection = Projection::new(source);
    let display = projection.display.to_string();
    let mut starts: Vec<usize> = Parser::new_ext(source, super::parser_options())
        .into_offset_iter()
        .filter_map(|(event, range)| {
            matches!(
                event,
                Event::Start(
                    Tag::Paragraph
                        | Tag::Heading { .. }
                        | Tag::CodeBlock(_)
                        | Tag::Item
                        | Tag::BlockQuote(_)
                        | Tag::HtmlBlock
                        | Tag::Table(_)
                )
            )
            .then_some(range.start)
        })
        .collect();
    starts.sort_unstable();
    let mut lines = Vec::new();
    let mut at = 0;
    for (index, text) in display.split('\n').enumerate() {
        let start = at;
        at += text.len() + 1;
        if text.trim().is_empty() {
            continue;
        }
        let (_, first) = projection.source_bounds(start);
        let line_start = source[..first].rfind('\n').map_or(0, |end| end + 1);
        let line_end = source[first..]
            .find('\n')
            .map_or(source.len(), |end| first + end);
        let caret = DisplayRange {
            start: DisplayOffset(start),
            end: DisplayOffset(start),
        };
        let blocks = projection.block_lines(caret);
        let Some(block) = blocks
            .iter()
            .find(|block| block.source.start <= first && first < block.source.end.max(first + 1))
            .or(blocks.last())
        else {
            continue;
        };
        let from = starts.partition_point(|&at| at < line_start);
        lines.push((
            index,
            Line {
                code: block.code,
                heading: block.heading,
                quote: block.quote_depth,
                list: block.list.as_ref().map(|list| list.depth),
                in_list: block.in_list,
                html: block.html,
                starts: starts.get(from).is_some_and(|&at| at <= first),
                source: source[line_start..line_end].to_owned(),
            },
        ));
    }
    (display, lines)
}
