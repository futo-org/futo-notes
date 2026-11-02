//! Intended row shapes: CommonMark numbering, retirement and retargeting.
use super::*;

/// Interpreted CommonMark numbering of the intended rows: a list continues
/// across blank rows while its marker, depth, parent and quotes stay the same.
pub(super) fn number(rows: &mut [Row]) {
    let touched: Vec<Range<usize>> = rows
        .iter()
        .filter(|row| row.changed())
        .filter_map(|row| row.list.as_ref().map(|list| list.owner.clone()))
        .collect();
    let mut lists: Vec<Option<(u8, u64, usize)>> = Vec::new();
    let mut quotes = None;
    for row in rows.iter_mut() {
        if row.blank {
            continue;
        }
        if quotes != Some(row.after.quotes) {
            lists.clear();
            quotes = Some(row.after.quotes);
        }
        let depth = row.after.depth;
        lists.truncate(depth);
        if depth == 0 || !row.after.opens {
            continue;
        }
        lists.resize(depth, None);
        let untouched = !row.changed()
            && row
                .list
                .as_ref()
                .is_some_and(|list| !touched.contains(&list.owner));
        let shape = &mut row.after;
        if shape.ordered() {
            let ordinal = match lists[depth - 1] {
                _ if untouched => row.before.ordinal.unwrap_or(1),
                Some((marker, next, key))
                    if marker == shape.marker && key == row.key && !row.pinned =>
                {
                    next
                }
                _ => row.start.unwrap_or(1),
            };
            shape.ordinal = Some(ordinal);
            lists[depth - 1] = Some((shape.marker, ordinal + 1, row.key));
        } else {
            shape.ordinal = None;
            lists[depth - 1] = Some((shape.marker, 0, row.key));
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Format {
    Code,
    Bullet,
    Ordered,
    Task,
    Heading(u8),
    Quote,
    Plain,
}

pub(super) fn format(rows: &[Row], index: usize) -> Format {
    let row = &rows[index];
    if row.code {
        return Format::Code;
    }
    if row.list.is_some() {
        let item = row.item().map_or(&row.before, |item| &rows[item].before);
        return if item.checked.is_some() {
            Format::Task
        } else if item.ordered() {
            Format::Ordered
        } else {
            Format::Bullet
        };
    }
    if row.before.heading > 0 {
        Format::Heading(row.before.heading)
    } else if row.before.quotes > 0 {
        Format::Quote
    } else {
        Format::Plain
    }
}

pub(super) fn bullet(marker: u8) -> bool {
    matches!(marker, b'-' | b'*' | b'+')
}

/// Retired items become paragraph text. Every later row of an item that
/// contained a retired item leaves that ancestor: one fewer list level each.
pub(super) fn retire(rows: &mut [Row], retired: &[usize], across_quotes: bool) {
    if retired.is_empty() {
        return;
    }
    let mut broken: Vec<(usize, usize)> = Vec::new();
    for &item in retired {
        for above in rows[item].chain.iter().flatten() {
            if *above != item
                && (across_quotes || rows[*above].before.quotes == rows[item].before.quotes)
            {
                broken.push((*above, item));
            }
        }
    }
    let removals: Vec<(usize, bool)> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let removed = row
                .chain
                .iter()
                .flatten()
                .filter(|above| {
                    retired.contains(above)
                        || broken
                            .iter()
                            .any(|(ancestor, item)| ancestor == *above && *item <= index)
                })
                .count();
            (
                removed,
                row.item().is_some_and(|item| retired.contains(&item)),
            )
        })
        .collect();
    for (row, (removed, own)) in rows.iter_mut().zip(removals) {
        if removed == 0 {
            continue;
        }
        let shape = &mut row.after;
        shape.depth = shape.depth.saturating_sub(removed);
        if shape.depth == 0 || own {
            shape.opens = false;
            shape.ordinal = None;
            shape.checked = None;
            shape.marker = 0;
        }
    }
}

/// Every item of the touched list takes the command's kind.
pub(super) fn retarget(rows: &mut [Row], owner: &Range<usize>, command: BlockCommand) {
    let start = rows
        .iter()
        .find(|row| row.before.opens && row.list.as_ref().is_some_and(|list| list.owner == *owner))
        .and_then(|row| row.before.ordinal);
    let mut first = true;
    for row in rows.iter_mut() {
        if !row.after.opens || row.list.as_ref().is_none_or(|list| list.owner != *owner) {
            continue;
        }
        row.pinned = std::mem::take(&mut first);
        let shape = &mut row.after;
        match command {
            BlockCommand::OrderedList => {
                if !shape.ordered() {
                    shape.marker = b'.';
                    row.start = Some(1);
                } else {
                    row.start = start.or(Some(1));
                }
                shape.checked = None;
            }
            BlockCommand::TaskList => {
                if !bullet(shape.marker) {
                    shape.marker = b'-';
                }
                shape.checked = Some(shape.checked.unwrap_or(false));
            }
            _ => {
                if !bullet(shape.marker) {
                    shape.marker = b'-';
                }
                shape.checked = None;
            }
        }
    }
}
