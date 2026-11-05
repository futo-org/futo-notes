//! List commands as intended row shapes; spelling is the generic path's job.
use super::shapes::{bullet, format, retarget, retire, Format};
use super::*;

impl EditorSession {
    /// Window rows around `range`; a retarget reads its whole touched lists.
    pub(super) fn command_rows(
        &self,
        range: DisplayRange,
        whole_lists: bool,
    ) -> (Range<usize>, Vec<Row>) {
        let lines = self.selected_list_lines(range);
        let selected: Vec<usize> = lines.iter().map(|line| line.source.start).collect();
        let mut low = range.start.0;
        let mut high = range.end.0;
        for list in lines
            .iter()
            .filter_map(|line| line.list.as_ref())
            .filter(|_| whole_lists)
        {
            low = low.min(self.projection.display_at(list.owner.start));
            high = high.max(self.projection.display_at(list.owner.end));
        }
        let (mut window, _) = self.projection.edit_window_with(
            DisplayRange {
                start: DisplayOffset(low),
                end: DisplayOffset(high),
            },
            whole_lists,
        );
        // Lists continue across blank lines: the window reaches the nearest
        // nonblank neighbor on each side so verification sees any merge.
        let blank = |line: usize| {
            let start = self.source.line_to_byte(line);
            let end = self.source.line_to_byte(line + 1);
            self.source
                .byte_slice(start..end)
                .chars()
                .all(|ch| matches!(ch, ' ' | '\t' | '>' | '\r' | '\n'))
        };
        let lines = self.source.len_lines();
        let mut line = self.source.byte_to_line(window.end);
        if window.end > 0 && blank(self.source.byte_to_line(window.end - 1)) || blank(line) {
            while line + 1 < lines && blank(line) {
                line += 1;
            }
            let at = DisplayOffset(self.projection.display_at(self.source.line_to_byte(line)));
            window.end = window.end.max(
                self.projection
                    .edit_window(DisplayRange { start: at, end: at })
                    .0
                    .end,
            );
        }
        let mut line = self.source.byte_to_line(window.start);
        if line > 0 && (blank(line) || blank(line - 1)) {
            while line > 0 && blank(line - 1) {
                line -= 1;
            }
            let at = DisplayOffset(
                self.projection
                    .display_at(self.source.line_to_byte(line.saturating_sub(1))),
            );
            window.start = window.start.min(
                self.projection
                    .edit_window(DisplayRange { start: at, end: at })
                    .0
                    .start,
            );
        }
        let rows = self.list_rows(&window, &selected);
        (window, rows)
    }

    /// Bullet/Ordered/Task retarget whole touched lists and create items from
    /// other text; Text or a repeated kind lifts the selected items.
    pub(in crate::session::blocks) fn list_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (has_seams, inspected) = self.projection.has_block_seams_with_work(range);
        let counted = |result: Result<Option<ViewChange>, EditorError>| {
            result.map(|change| {
                change.map(|mut change| {
                    change.work.link_metadata_items += inspected;
                    change
                })
            })
        };
        if has_seams
            || self
                .projection
                .has_multiline_block_code(&self.source, range)
        {
            // Inline marks and code close and reopen at the new block seams first.
            return counted(self.stage_block_action(
                expected,
                range,
                None,
                accept,
                |staged, local, accept| {
                    let seams = staged.split_inline_block_seams(local, accept)?;
                    let mut change =
                        staged.list_rows_command(staged.revision(), local, command, accept)?;
                    if let (Some(change), Some(seams)) = (&mut change, seams) {
                        accumulate_planning_work(&mut change.work, seams.work);
                    }
                    Ok(change)
                },
            ));
        }
        counted(self.list_rows_command(expected, range, command, accept))
    }

    fn list_rows_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let selected = self.selected_list_lines(range);
        let repeating = !selected.is_empty()
            && selected.iter().all(|line| {
                line.list.as_ref().is_some_and(|list| match command {
                    BlockCommand::BulletList => list.ordinal.is_none() && list.checked.is_none(),
                    BlockCommand::OrderedList => list.ordinal.is_some() && list.checked.is_none(),
                    BlockCommand::TaskList => list.checked.is_some(),
                    _ => false,
                })
            });
        // A repeated kind lifts the selected items; it does not retarget the
        // complete list. Keep the ordinary neighbor window for that action.
        let (window, mut rows) =
            self.command_rows(range, command != BlockCommand::Heading(0) && !repeating);
        let written = rows
            .iter()
            .any(|row| row.selected && (!row.blank || row.before.heading > 0 || row.before.opens));
        let mut run = 0;
        let mut previous = None;
        let mut retired = Vec::new();
        let mut owners: Vec<Range<usize>> = Vec::new();
        let mut created = Vec::new();
        let mut ancestor: Option<(usize, usize)> = None;
        for index in 0..rows.len() {
            let row = &rows[index];
            if !row.selected || row.divider {
                continue;
            }
            if written && row.blank && row.list.is_none() && row.before.quotes == 0 {
                continue;
            }
            let format = format(&rows, index);
            if previous.is_some_and(|previous| previous != format) {
                run += 1;
            }
            previous = Some(format);
            if format == Format::Code {
                continue;
            }
            let removes = command == BlockCommand::Heading(0)
                || matches!(
                    (format, command),
                    (Format::Bullet, BlockCommand::BulletList)
                        | (Format::Ordered, BlockCommand::OrderedList)
                        | (Format::Task, BlockCommand::TaskList)
                );
            if let Some(list) = &row.list {
                let item = row.item().ok_or(EditorError::UnrepresentableFormat)?;
                if !removes {
                    if !owners.contains(&list.owner) {
                        owners.push(list.owner.clone());
                    }
                    continue;
                }
                if ancestor.is_some_and(|(above, owner_run)| {
                    owner_run == run && above != item && row.chain.contains(&Some(above))
                }) {
                    continue;
                }
                if !retired.contains(&item) {
                    retired.push(item);
                }
                ancestor = Some((item, run));
            } else if command == BlockCommand::Heading(0) {
                rows[index].retire_heading();
            } else if !row.blank || !written {
                // A caret on a blank line (nothing else selected) starts an
                // empty item there; within a wider selection blank rows stay.
                created.push((index, format));
            }
        }
        if command == BlockCommand::Heading(0) {
            for row in rows.iter_mut() {
                if row.item().is_some_and(|item| retired.contains(&item)) {
                    row.retire_heading();
                }
            }
        }
        retire(&mut rows, &retired, true);
        for owner in &owners {
            retarget(&mut rows, owner, command);
        }
        let mut previous_created = None;
        for (index, format) in created {
            let row = &mut rows[index];
            row.pinned = previous_created.is_none_or(|(previous, _)| previous + 1 < index);
            let key = match previous_created {
                Some((previous, key)) if !row.pinned && previous + 1 == index => key,
                _ => usize::MAX - index,
            };
            row.key = key;
            previous_created = Some((index, key));
            // A blank row chosen for a new item is written as one (an empty
            // item); reparse verification and its repairs still apply.
            row.from_blank = row.blank;
            row.blank = false;
            row.retire_heading();
            row.after.depth = 1;
            row.after.opens = true;
            if format == Format::Quote {
                row.after.quotes = 0;
            }
            row.after.marker = if command == BlockCommand::OrderedList {
                b'.'
            } else {
                b'-'
            };
            row.after.checked = (command == BlockCommand::TaskList).then_some(false);
            row.start = Some(1);
        }
        self.commit_rows(expected, range, window, rows, accept)
    }

    /// Key exits lift the current item into paragraph text; an empty item
    /// becomes an unlisted empty paragraph.
    pub(in crate::session::blocks) fn lift_current_list(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (window, mut rows) = self.command_rows(range, false);
        let Some(first) = rows
            .iter()
            .position(|row| row.selected && row.list.is_some())
        else {
            return Ok(None);
        };
        let item = rows[first]
            .item()
            .ok_or(EditorError::UnrepresentableFormat)?;
        retire(&mut rows, &[item], false);
        // An exited empty item must not stay a blank row of the list that
        // continues after it; a trailing one needs no separator.
        let continues = rows[item + 1..].iter().any(|row| !row.blank);
        let row = &mut rows[item];
        if row.body.is_empty() && !row.code {
            row.blank = true;
            row.exact_blank = continues;
        }
        self.commit_rows(expected, range, window, rows, accept)
    }
}

impl EditorSession {
    /// A typed list shortcut whose prefix was already removed: the current row
    /// becomes an item (or task) that joins a preceding bullet list, or an
    /// ordered list only at the typed number.
    pub(in crate::session::blocks) fn list_shortcut(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        start: Option<u64>,
        task: Option<bool>,
        typed: usize,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (window, mut rows) = self.command_rows(range, false);
        let index = rows
            .iter()
            .position(|row| row.selected)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let row = &mut rows[index];
        if typed < row.body.start || typed > row.line.end {
            return Err(EditorError::UnrepresentableFormat);
        }
        row.body.start = typed;
        row.forced = true;
        // A typed marker with nothing after it is an empty item, which cannot
        // interrupt a paragraph: it gets the blank-line repair a list command
        // gives a blank row.
        row.from_blank |= row.body.is_empty();
        if let Some(checked) = task {
            if !row.before.opens {
                return Ok(None);
            }
            row.after.checked = Some(checked);
            return self.commit_rows(expected, range, window, rows, accept);
        }
        let quotes = row.before.quotes;
        // Join the preceding root list: any bullet list, or an ordered list
        // whose next number is the typed one.
        let previous = rows[..index]
            .iter()
            .rev()
            .find(|row| !row.blank)
            .filter(|row| row.after.quotes == quotes && row.after.depth > 0)
            .and_then(|row| row.chain.first().copied().flatten());
        let last = previous.and_then(|root| {
            rows[root..index]
                .iter()
                .rfind(|row| row.after.opens && row.after.depth == 1)
        });
        let joined = last
            .filter(|last| match start {
                None => bullet(last.after.marker),
                Some(start) => {
                    last.after.ordered() && last.after.ordinal.map(|n| n + 1) == Some(start)
                }
            })
            .map(|last| (last.after.marker, last.key));
        let row = &mut rows[index];
        row.after = Shape {
            quotes,
            depth: 1,
            opens: true,
            ordinal: None,
            checked: None,
            heading: 0,
            inner: 0,
            marker: joined.map_or(if start.is_some() { b'.' } else { b'-' }, |(marker, _)| {
                marker
            }),
        };
        row.start = start;
        row.pinned = start.is_some() && joined.is_none();
        row.key = joined.map_or(usize::MAX - index, |(_, key)| key);
        row.blank = false;
        self.commit_rows(expected, range, window, rows, accept)
    }
}

impl EditorSession {
    /// Text retires heading syntax; Quote adds a quote to unquoted selected
    /// rows (a heading becomes quoted text); Indent/Outdent add or remove one
    /// quote level on quoted rows. Code and divider rows keep their bytes.
    pub(in crate::session::blocks) fn quote_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (window, mut rows) = self.command_rows(range, false);
        for row in rows
            .iter_mut()
            .filter(|row| row.selected && !row.code && !row.divider)
        {
            let quotes = row.before.quotes;
            match command {
                BlockCommand::Heading(0) => row.retire_heading(),
                BlockCommand::Quote if row.list.is_none() => {
                    row.retire_heading();
                    row.after.quotes = quotes.max(1);
                }
                BlockCommand::Indent if row.before.inner > 0 => row.after.inner += 1,
                BlockCommand::Outdent if row.before.inner > 0 => row.after.inner -= 1,
                BlockCommand::Indent if quotes > 0 => row.after.quotes += 1,
                BlockCommand::Outdent if quotes > 0 => row.after.quotes -= 1,
                _ => {}
            }
        }
        // A newly quoted empty line keeps a following paragraph out of the
        // quote that typing into it will open; an ordered list that cannot
        // interrupt a paragraph keeps a real blank line before it.
        for index in 1..rows.len() {
            let (above, row) = (&rows[index - 1], &rows[index]);
            if !above.blank
                && above.after.quotes > above.before.quotes
                && !row.changed()
                && row.before.opens
                && row.before.quotes < above.after.quotes
                && row.before.ordinal.is_some_and(|ordinal| ordinal != 1)
            {
                rows[index].insert = Insert::Blank;
                continue;
            }
            if above.blank
                && above.after.quotes > above.before.quotes
                && !row.blank
                && !row.code
                && row.before.heading == 0
                && row.list.is_none()
                && !row.changed()
                && row.after.quotes < above.after.quotes
            {
                rows[index].insert = Insert::Blank;
            }
        }
        self.commit_rows(expected, range, window, rows, accept)
    }
}
