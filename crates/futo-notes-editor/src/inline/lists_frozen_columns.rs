//! Frozen e7af608b5 constructor for independent all-field physical-column proof.
use super::*;

pub(in crate::inline) fn describe(
    source: &str,
    events: &[(Event<'_>, Range<usize>)],
) -> ListCursor {
    let mut prefixes = Vec::new();
    let mut items: Vec<ListLine> = Vec::new();
    let mut tasks = Vec::new();
    let mut quote_depth = 0;
    let mut lists: Vec<(Range<usize>, Option<u64>)> = Vec::new();
    let mut active_items: Vec<usize> = Vec::new();
    let mut previous_items = Vec::new();
    let mut last_child: Vec<Option<usize>> = Vec::new();
    for (event, range) in events {
        visit_container();
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
                let first_start = source[..start].rfind('\n').map_or(0, |at| at + 1);
                prefixes.push((start, start + width + padding));
                let marker_column = old_columns(&source[first_start..start], 0);
                let content_column =
                    old_columns(&source[start..start + width + padding], marker_column);
                let previous_content_column = previous_items
                    .last()
                    .unwrap()
                    .map(|at| items[at].content_column);
                let sink = previous_items
                    .last()
                    .copied()
                    .flatten()
                    .and_then(|previous| last_child[previous])
                    .filter(|&child| {
                        items[child].ordinal.is_some() == ordinal.is_some()
                            && items[child].quote_depth == quote_depth
                    })
                    .map(|child| SinkTarget {
                        marker: items[child].marker.clone(),
                        next_number: items[child].ordinal.map(|number| number + 1),
                        column: items[child].marker_column,
                    });
                *previous_items.last_mut().unwrap() = Some(items.len());
                let parent = active_items
                    .last()
                    .filter(|&&at| items[at].quote_depth == quote_depth);
                let outer_item =
                    parent.map_or_else(|| range.clone(), |&at| items[at].outer_item.clone());
                let outer_depth = parent.map_or(depth, |&at| items[at].outer_depth);
                let parent_marker_column = parent.map(|&at| items[at].marker_column);
                let parent_marker = parent.map(|&at| items[at].marker.clone());
                let parent_number = parent.and_then(|&at| items[at].ordinal);
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
                    outer_depth,
                    ordinal,
                    depth,
                    checked: None,
                    first: true,
                    indent: start + width + padding - first_start,
                    marker_column,
                    content_column,
                    previous_content_column,
                    sink,
                    parent_marker_column,
                    parent_marker,
                    parent_number,
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

fn old_columns(raw: &str, mut column: usize) -> usize {
    for byte in raw.bytes() {
        visit_container();
        column += if byte == b'\t' { 4 - column % 4 } else { 1 };
    }
    column
}
