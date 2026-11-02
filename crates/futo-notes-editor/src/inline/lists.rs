//! CommonMark events own list identity; exact prefixes remain source spelling.
use pulldown_cmark::{Event, Tag, TagEnd};
use std::ops::Range;

#[derive(Clone, Debug)]
pub(crate) struct ListLine {
    pub marker: Range<usize>,
    pub owner: Range<usize>,
    pub item: Range<usize>,
    pub outer_item: Range<usize>,
    pub ordinal: Option<u64>,
    pub depth: usize,
    pub checked: Option<bool>,
    pub first: bool,
    pub indent: usize,
    pub marker_column: usize,
    pub content_column: usize,
    pub previous_content_column: Option<usize>,
    pub parent_marker_column: Option<usize>,
    pub parent_content_column: Option<usize>,
    pub quote_depth: usize,
}

impl ListLine {
    pub fn shift(&mut self, by: usize) {
        for range in [
            &mut self.marker,
            &mut self.owner,
            &mut self.item,
            &mut self.outer_item,
        ]
        .into_iter()
        {
            range.start += by;
            range.end += by;
        }
    }
}

pub(super) struct Attribution {
    pub list: Option<ListLine>,
    pub task: Option<Range<usize>>,
    pub prefix_end: Option<usize>,
}

/// Physical lines arrive in source order. Each item, prefix and task marker is
/// visited once, rather than rescanning every event for every line of a list.
pub(super) struct ListCursor {
    items: Vec<ListLine>,
    prefixes: Vec<(usize, usize)>,
    tasks: Vec<Range<usize>>,
    active: Vec<usize>,
    next_item: usize,
    next_prefix: usize,
    next_task: usize,
}

impl ListCursor {
    pub fn line(&mut self, start: usize, end: usize) -> Attribution {
        while self.next_item < self.items.len() && self.items[self.next_item].item.start <= end {
            let next = self.next_item;
            while self
                .active
                .last()
                .is_some_and(|&at| self.items[at].item.end <= self.items[next].item.start)
            {
                self.active.pop();
            }
            self.active.push(next);
            self.next_item += 1;
        }
        while self
            .active
            .last()
            .is_some_and(|&at| self.items[at].item.end <= start)
        {
            self.active.pop();
        }
        let list = self.active.last().map(|&at| {
            let mut list = self.items[at].clone();
            list.first = start <= list.marker.start && list.marker.start <= end;
            list
        });
        let mut prefix_end = None;
        while let Some(&(at, prefix)) = self
            .prefixes
            .get(self.next_prefix)
            .filter(|(at, _)| *at <= end)
        {
            if at >= start {
                prefix_end = Some(prefix_end.map_or(prefix, |old: usize| old.max(prefix)));
            }
            self.next_prefix += 1;
        }
        let mut task = None;
        while let Some(next) = self
            .tasks
            .get(self.next_task)
            .filter(|task| task.start <= end)
        {
            if next.start >= start {
                task = Some(next.clone());
            }
            self.next_task += 1;
        }
        Attribution {
            list,
            task,
            prefix_end,
        }
    }
}

pub(super) fn describe(source: &str, events: &[(Event<'_>, Range<usize>)]) -> ListCursor {
    let mut prefixes = Vec::new();
    let mut items: Vec<ListLine> = Vec::new();
    let mut tasks = Vec::new();
    let mut quote_depth = 0;
    let mut lists: Vec<(Range<usize>, Option<u64>)> = Vec::new();
    let mut active_items: Vec<usize> = Vec::new();
    let mut previous_items = Vec::new();
    let mut last_child: Vec<Option<usize>> = Vec::new();
    let mut physical = PhysicalColumns::default();
    for (event, range) in events {
        if matches!(
            event,
            Event::Start(
                Tag::Paragraph | Tag::Heading { .. } | Tag::CodeBlock(_) | Tag::BlockQuote(_)
            ) | Event::Html(_)
                | Event::Rule
        ) {
            if let Some(&parent) = active_items.last() {
                last_child[parent] = None;
            }
        }
        match event {
            Event::Start(Tag::BlockQuote(_)) => quote_depth += 1,
            Event::End(TagEnd::BlockQuote(_)) => quote_depth -= 1,
            Event::Start(Tag::List(number)) => {
                lists.push((range.clone(), *number));
                previous_items.push(None::<usize>);
            }
            Event::End(TagEnd::List(_)) => {
                lists.pop();
                previous_items.pop();
            }
            Event::End(TagEnd::Item) => {
                active_items.pop();
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
                let (first_start, marker_column) = physical.at_marker(source, start);
                prefixes.push((start, start + width + padding));
                let content_column =
                    columns(&source[start..start + width + padding], marker_column);
                let previous_content_column = previous_items
                    .last()
                    .unwrap()
                    .map(|at| items[at].content_column);
                *previous_items.last_mut().unwrap() = Some(items.len());
                let parent = active_items
                    .last()
                    .filter(|&&at| items[at].quote_depth == quote_depth);
                let outer_item =
                    parent.map_or_else(|| range.clone(), |&at| items[at].outer_item.clone());
                let parent_marker_column = parent.map(|&at| items[at].marker_column);
                let parent_content_column = parent.map(|&at| items[at].content_column);
                if let Some(&parent) = parent {
                    last_child[parent] = Some(items.len());
                }
                active_items.push(items.len());
                items.push(ListLine {
                    marker: start..start + width,
                    owner: owner.clone(),
                    item: range.clone(),
                    outer_item,
                    ordinal,
                    depth,
                    checked: None,
                    first: true,
                    indent: start + width + padding - first_start,
                    marker_column,
                    content_column,
                    previous_content_column,
                    parent_marker_column,
                    parent_content_column,
                    quote_depth,
                });
                last_child.push(None);
            }
            Event::TaskListMarker(checked) => {
                let end = range.end
                    + usize::from(matches!(
                        source.as_bytes().get(range.end),
                        Some(b' ' | b'\t')
                    ));
                prefixes.push((range.start, end));
                let at = range.start + source[range.clone()].find('[').unwrap();
                tasks.push(at..at + 3);
                items[*active_items.last().unwrap()].checked = Some(*checked);
            }
            _ => {}
        }
    }
    ListCursor {
        items,
        prefixes,
        tasks,
        active: Vec::new(),
        next_item: 0,
        next_prefix: 0,
        next_task: 0,
    }
}

/// Canonical item starts arrive in source order. Carry physical byte/column
/// position across them rather than rereading a shared prefix per nested item.
#[derive(Default)]
struct PhysicalColumns {
    at: usize,
    line: usize,
    column: usize,
}

impl PhysicalColumns {
    fn at_marker(&mut self, source: &str, marker: usize) -> (usize, usize) {
        if marker < self.at {
            // Preserve the old result for a privately supplied noncanonical
            // event stream; real parser Item starts are monotonically ordered.
            *self = Self::default();
        }
        for byte in source.as_bytes()[self.at..marker].iter().copied() {
            self.at += 1;
            if byte == b'\n' {
                self.line = self.at;
                self.column = 0;
            } else {
                self.column += if byte == b'\t' {
                    4 - self.column % 4
                } else {
                    1
                };
            }
        }
        (self.line, self.column)
    }
}

/// CommonMark columns expand a tab to the next four-column stop.
pub(crate) fn columns(raw: &str, mut column: usize) -> usize {
    for byte in raw.bytes() {
        column += if byte == b'\t' { 4 - column % 4 } else { 1 };
    }
    column
}
