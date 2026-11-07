//! Indent and Outdent of list items: the moved items, their new list, and
//! for an Outdent the scoped window it reads.
use super::shapes::retire;
use super::*;

impl EditorSession {
    /// Indent moves the selected items of the first item's list, with their
    /// descendants, under the previous sibling; Outdent moves them one level
    /// out, and a root item becomes paragraph text.
    pub(in crate::session::blocks) fn indent_list(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (window, mut rows) = self.indent_rows(range, command);
        for row in &mut rows {
            row.lenient = true;
        }
        let Some(first) = rows.iter().position(|row| row.selected && !row.code) else {
            return Ok(None);
        };
        let Some(list) = rows[first].list.clone() else {
            return Ok(None);
        };
        let item = rows[first]
            .item()
            .ok_or(EditorError::UnrepresentableFormat)?;
        if command == BlockCommand::Indent && list.previous_content_column.is_none() {
            return Ok(None);
        }
        let parent = list
            .depth
            .checked_sub(2)
            .and_then(|at| rows[item].chain[at]);
        if command == BlockCommand::Outdent
            && parent.is_none_or(|parent| rows[parent].before.quotes != rows[item].before.quotes)
        {
            retire(&mut rows, &[item], false);
            return self.commit_rows(expected, range, window, rows, accept);
        }
        let last = rows.iter().rposition(|row| row.selected).unwrap_or(first);
        let moved: Vec<usize> = (item..=last)
            .filter(|&index| {
                let row = &rows[index];
                row.before.opens
                    && row
                        .list
                        .as_ref()
                        .is_some_and(|other| other.owner == list.owner)
            })
            .collect();
        // Moved items join the list at their new level and take its marker.
        let depth = list.depth;
        let joined = if command == BlockCommand::Indent {
            let sibling = (0..item)
                .rev()
                .find(|&at| rows[at].before.opens && rows[at].before.depth == depth)
                .ok_or(EditorError::UnrepresentableFormat)?;
            (sibling + 1..item)
                .rev()
                .find(|&at| {
                    rows[at].before.opens
                        && rows[at].before.depth == depth + 1
                        && rows[at].before.quotes == rows[item].before.quotes
                        && rows[at].chain.contains(&Some(sibling))
                })
                .map(|at| (rows[at].before.marker, rows[at].key))
        } else {
            rows[item].chain[depth - 2].map(|parent| (rows[parent].before.marker, rows[parent].key))
        };
        // An empty item cannot open a new sub-list right under its sibling's
        // text (it cannot interrupt a paragraph): the blank-line repair
        // separates them, as for a blank row turned into an item.
        if command == BlockCommand::Indent {
            rows[item].from_blank |= rows[item].body.is_empty();
        }
        for row in rows.iter_mut() {
            if !row
                .chain
                .iter()
                .any(|at| at.is_some_and(|at| moved.contains(&at)))
            {
                continue;
            }
            if command == BlockCommand::Indent {
                row.after.depth += 1;
            } else {
                row.after.depth -= 1;
            }
        }
        // Outdented items leave their old list: its later items, now nested
        // under the last moved item, form a new list.
        if command == BlockCommand::Outdent {
            let old = rows[item].key;
            let last = *moved.last().unwrap_or(&item);
            let mut first = true;
            for row in rows[last + 1..].iter_mut() {
                if !row.blank && row.before.depth < depth {
                    break;
                }
                if row.before.opens && row.key == old && row.before.depth == depth {
                    row.key = usize::MAX / 2 - last;
                    // The new list of children counts from one.
                    if std::mem::take(&mut first) {
                        row.start = Some(1);
                        row.pinned = true;
                    }
                }
            }
        }
        for &at in &moved {
            let row = &mut rows[at];
            match joined {
                Some((marker, key)) => {
                    row.after.marker = marker;
                    row.key = key;
                }
                None => {
                    row.key = usize::MAX - moved[0];
                    if row.after.ordered() {
                        row.start = Some(1);
                        row.pinned = at == moved[0];
                    }
                }
            }
        }
        self.commit_rows(expected, range, window, rows, accept)
    }

    /// An Outdent's own scoped rows, else the general window's.
    fn indent_rows(&self, range: DisplayRange, command: BlockCommand) -> (Range<usize>, Vec<Row>) {
        let scoped = (command == BlockCommand::Outdent)
            .then(|| self.outdent_window(range))
            .flatten();
        let Some(window) = scoped else {
            return self.command_rows(range, false);
        };
        let selected: Vec<usize> = self
            .selected_list_lines(range)
            .iter()
            .map(|line| line.source.start)
            .collect();
        let rows = self.list_rows(&window, &selected);
        (window, rows)
    }

    /// The rows an Outdent of one nested item reads: its parent item, where
    /// its later siblings stay as its children, and for an ordered parent
    /// list the rest of that list, which the outdented item renumbers. `None` keeps
    /// the general window (a blank line beside it, a quote, a root item).
    fn outdent_window(&self, range: DisplayRange) -> Option<Range<usize>> {
        let lines = self.selected_list_lines(range);
        let line = lines.first()?;
        let list = line.list.as_ref().filter(|list| list.depth > 1)?;
        if line.quote_depth > 0 || list.quote_depth > 0 || lines.len() > 1 {
            return None;
        }
        // The parent's own lines come right before its nested list.
        let own = self.source.byte_to_line(list.owner.start);
        let previous = self.source.line_to_byte(own.checked_sub(1)?);
        let parent = self
            .projection
            .list_command_lines_in_source(&(previous..list.owner.start))
            .into_iter()
            .find_map(|line| line.list.filter(|parent| parent.depth + 1 == list.depth))?;
        let rows = &self.projection.rows;
        let first = rows.locate(parent.item.start, false);
        // Only an ordered parent list renumbers its items after the parent.
        let end = if parent.ordinal.is_some() {
            parent.owner.end
        } else {
            parent.item.end
        };
        let last = rows.locate(end.saturating_sub(1), false);
        let (head, start, _) = rows.at(first);
        let (tail, end, _) = rows.at(last);
        let end = end + tail.source_len;
        // A row continuing a paragraph or block has no context to parse after.
        if head.continues && head.start_depth() == 0 || start == 0 && head.continues {
            return None;
        }
        let blank = |at: usize| {
            let line = self.source.byte_to_line(at);
            self.source
                .line(line)
                .chars()
                .all(|ch| matches!(ch, ' ' | '\t' | '\r' | '\n'))
        };
        if start > 0 && blank(start - 1) || end < self.source.len_bytes() && blank(end) {
            return None;
        }
        Some(start..end)
    }
}
