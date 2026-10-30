//! CommonMark events own list identity; exact prefixes remain source spelling.
use pulldown_cmark::{Event, Tag, TagEnd};
use std::ops::Range;

#[derive(Clone, Debug)]
pub(crate) struct ListLine {
    pub marker: Range<usize>,
    pub owner: Range<usize>,
    pub item: Range<usize>,
    pub ordinal: Option<u64>,
    pub depth: usize,
    pub checked: Option<bool>,
    pub first: bool,
}

impl ListLine {
    pub fn shift(&mut self, by: usize) {
        for range in [&mut self.marker, &mut self.owner, &mut self.item] {
            range.start += by;
            range.end += by;
        }
    }
}

pub(super) fn describe(
    source: &str,
    events: &[(Event<'_>, Range<usize>)],
) -> (Vec<(usize, usize)>, Vec<ListLine>) {
    let mut prefixes = Vec::new();
    let mut items: Vec<ListLine> = Vec::new();
    let mut lists: Vec<(Range<usize>, Option<u64>)> = Vec::new();
    for (event, range) in events {
        match event {
            Event::Start(Tag::List(number)) => lists.push((range.clone(), *number)),
            Event::End(TagEnd::List(_)) => {
                lists.pop();
            }
            Event::Start(Tag::Item) => {
                let depth = lists.len();
                let (owner, number) = lists.last_mut().unwrap();
                let ordinal = *number;
                if let Some(number) = number {
                    *number += 1;
                }
                let raw = &source[range.clone()];
                let indent = raw
                    .bytes()
                    .take_while(|b| matches!(b, b' ' | b'\t'))
                    .count();
                let raw = &raw[indent..];
                let digits = raw.bytes().take_while(u8::is_ascii_digit).count();
                let width = if digits > 0 { digits + 1 } else { 1 };
                let padding = raw[width..]
                    .bytes()
                    .take_while(|b| matches!(b, b' ' | b'\t'))
                    .count();
                let padding = if padding > 4 { 1 } else { padding };
                let start = range.start + indent;
                prefixes.push((start, start + width + padding));
                items.push(ListLine {
                    marker: start..start + width,
                    owner: owner.clone(),
                    item: range.clone(),
                    ordinal,
                    depth,
                    checked: None,
                    first: true,
                });
            }
            Event::TaskListMarker(checked) => {
                let end = range.end
                    + usize::from(matches!(
                        source.as_bytes().get(range.end),
                        Some(b' ' | b'\t')
                    ));
                prefixes.push((range.start, end));
                if let Some(item) = items
                    .iter_mut()
                    .rev()
                    .find(|item| item.item.start <= range.start && range.end <= item.item.end)
                {
                    item.checked = Some(*checked);
                }
            }
            _ => {}
        }
    }
    (prefixes, items)
}
