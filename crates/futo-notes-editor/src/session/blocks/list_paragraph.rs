//! Enter spelling and list numbering after list-key routing chooses insertion.
use super::*;

/// Source replacements, each a byte range and its new text.
type RowEdits = Vec<(std::ops::Range<usize>, String)>;

impl EditorSession {
    pub(super) fn insert_list_paragraph(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        lines: Vec<crate::inline::blocks::BlockLine>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let line = &lines[0];
        let prefix = self
            .source
            .byte_slice(line.source.start..line.content.start)
            .to_string();
        if line.content.is_empty() {
            if line.list.as_ref().is_some_and(|list| {
                list.parent_marker_column.is_some() && line.quote_depth == list.quote_depth
            }) {
                return self.outdent_list(expected, range, accept);
            }
            // Leaving a list at its last item: a line written straight under it
            // would join that item as a lazy continuation, so a blank line
            // separates the paragraph the user is about to type.
            let separate = line.quote_depth == 0
                && line.list.as_ref().is_some_and(|list| {
                    list.owner.start < line.source.start && list.owner.end <= line.source.end
                });
            if !separate {
                return self.lift_current_list(expected, range, accept);
            }
            return self.stage_block_action(
                expected,
                range,
                None,
                accept,
                |staged, local, accept| {
                    let Some(lifted) =
                        staged.lift_current_list(staged.revision(), local, accept)?
                    else {
                        return Ok(None);
                    };
                    let caret = staged.selection();
                    let (at, _) = staged.projection.source_bounds(caret.start.0);
                    let mut change = staged.commit_block_key(
                        staged.revision(),
                        caret,
                        at..at,
                        "\n",
                        at + 1,
                        accept,
                    )?;
                    crate::session::transaction::accumulate_planning_work(
                        &mut change.work,
                        lifted.work,
                    );
                    Ok(Some(change))
                },
            );
        }
        let list = line.list.as_ref().unwrap();
        let at_start = range.start.0 == self.projection.display_at(line.content.start);
        if list.first && at_start && range.start == range.end {
            let quote =
                &prefix[..super::indent_source::quote_prefix_end(&prefix, line.quote_depth)];
            return self.enter_at_item_start(expected, range, &format!("{quote}\n"), accept);
        }
        let body = self.split_block_body(&lines, range)?;
        let origin = if list.first {
            line.clone()
        } else {
            let start = self
                .source
                .line_to_byte(self.source.byte_to_line(list.marker.start));
            let point = DisplayOffset(self.projection.display_at(start));
            self.projection
                .block_lines(DisplayRange {
                    start: point,
                    end: point,
                })
                .into_iter()
                .find(|line| {
                    line.list
                        .as_ref()
                        .is_some_and(|item| item.first && item.marker == list.marker)
                })
                .ok_or(EditorError::UnrepresentableFormat)?
        };
        let mut prefix = prefix;
        if list.first {
            if let Some(number) = list.ordinal {
                replace_number(&mut prefix, line, number)?;
            }
        }
        let mut continuation = self
            .source
            .byte_slice(origin.source.start..origin.content.start)
            .to_string();
        if let Some(number) = list.ordinal {
            replace_number(&mut continuation, &origin, number + 1)?;
        }
        let mut left_prefix = prefix.clone();
        if origin.task.is_some() {
            let target = if list.first && at_start {
                &mut left_prefix
            } else {
                &mut continuation
            };
            let at = target.rfind('[').unwrap() + 1;
            target.replace_range(at..at + 1, " ");
        }
        // The item's later rows now follow the new marker and must stay in it.
        let opens_empty = body.right.is_empty() && origin.task.is_none();
        let (moved, blanks) = self.moved_item_rows(line, &origin, &continuation, opens_empty)?;
        let output = format!(
            "{left_prefix}{}\n{blanks}{continuation}{}",
            body.left, body.right
        );
        let mut caret = line.source.start
            + left_prefix.len()
            + body.left.len()
            + 1
            + blanks.len()
            + continuation.len();
        let mut edits = vec![(line.source.start..line.content.end, output)];
        edits.extend(moved);
        // The split closed and reopened formatting at the caret line's edges;
        // the paragraph's rows above and below it must close and reopen too.
        let (above, below) = self.paragraph_rows_around(line);
        for rows in [above, below] {
            for (range, text) in self.standalone_rows(&rows)? {
                if range.start < line.source.start {
                    caret = caret + text.len() - range.len();
                }
                edits.push((range, text));
            }
        }
        if list.ordinal.is_some() {
            let group = DisplayRange {
                start: DisplayOffset(self.projection.display_at(list.owner.start)),
                end: DisplayOffset(self.projection.display_at(list.owner.end)),
            };
            for other in self.projection.block_lines(group) {
                let Some(item) = other.list.as_ref() else {
                    continue;
                };
                if !item.first
                    || item.owner != list.owner
                    || item.marker == list.marker && list.first
                {
                    continue;
                }
                let Some(number) = item.ordinal else {
                    continue;
                };
                let number = number + u64::from(item.marker.start > list.marker.start);
                let digits = item.marker.start..item.marker.end - 1;
                let replacement = physical_number(number).to_string();
                if digits.start < line.source.start {
                    caret = caret - digits.len() + replacement.len();
                }
                edits.push((digits, replacement));
            }
        }
        edits.sort_by_key(|(range, _)| range.start);
        let footprint = edits.first().unwrap().0.start..edits.last().unwrap().0.end;
        let mut output = self.source.byte_slice(footprint.clone()).to_string();
        for (range, text) in edits.into_iter().rev() {
            output.replace_range(
                range.start - footprint.start..range.end - footprint.start,
                &text,
            );
        }
        let mut change = self.commit_block_edit(
            expected,
            footprint,
            &output,
            BlockSelection::Source(caret),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, body.formats, body.affinity);
        change.work.materialized_source_bytes += body.materialized;
        change.work.parsed_source_bytes += body.parsed;
        Ok(Some(change))
    }

    /// The rows of the caret line's paragraph above and below it (lazy or
    /// indented continuation lines of the same item).
    fn paragraph_rows_around(
        &self,
        line: &crate::inline::blocks::BlockLine,
    ) -> (
        Vec<crate::inline::blocks::BlockLine>,
        Vec<crate::inline::blocks::BlockLine>,
    ) {
        let item = &line.list.as_ref().unwrap().item;
        let display = &self.projection.display;
        let row = |index: usize| {
            let point = DisplayOffset(display.line_to_byte(index));
            self.projection
                .block_lines(DisplayRange {
                    start: point,
                    end: point,
                })
                .into_iter()
                .next()
        };
        let same = |other: &crate::inline::blocks::BlockLine| {
            other.paragraph_text
                && !other.code
                && other.heading == 0
                && other.list.as_ref().is_some_and(|list| &list.item == item)
        };
        let at = display.byte_to_line(self.projection.display_at(line.content.start));
        let mut above = Vec::new();
        if !line.list.as_ref().unwrap().first {
            for index in (0..at).rev() {
                let Some(other) = row(index).filter(|other| same(other)) else {
                    break;
                };
                let first = other.list.as_ref().unwrap().first;
                above.push(other);
                if first {
                    break;
                }
            }
            above.reverse();
        }
        let mut below = Vec::new();
        for index in at + 1..display.len_lines() {
            match row(index) {
                Some(other) if same(&other) && !other.list.as_ref().unwrap().first => {
                    below.push(other)
                }
                _ => break,
            }
        }
        (above, below)
    }

    /// Content edits that spell `rows` as a paragraph of their own, closing and
    /// reopening any formatting that crossed their edges. Unchanged physical
    /// bodies keep their bytes.
    fn standalone_rows(
        &self,
        rows: &[crate::inline::blocks::BlockLine],
    ) -> Result<RowEdits, EditorError> {
        let (Some(first), Some(last)) = (rows.first(), rows.last()) else {
            return Ok(Vec::new());
        };
        let range = DisplayRange {
            start: DisplayOffset(self.projection.display_at(first.content.start)),
            end: DisplayOffset(self.projection.display_at(last.content.end)),
        };
        let text = self
            .projection
            .body_source(&self.source, range, false, self.revision)?
            .text;
        let bodies = rows.iter().flat_map(|row| &row.bodies).collect::<Vec<_>>();
        let parts = text.split('\n').collect::<Vec<_>>();
        if parts.len() != bodies.len() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut edits = Vec::new();
        for (body, part) in bodies.into_iter().zip(parts) {
            let part = part.trim_end_matches('\r');
            if self.source.byte_slice(body.content.clone()) != part {
                edits.push((body.content.clone(), part.to_owned()));
            }
        }
        Ok(edits)
    }

    /// Indentation edits that keep the split item's later rows inside the new
    /// item. `continuation` is the new item's prefix; when it `opens_empty`
    /// (no text on its own line) its rows need its full content column, so
    /// lazy continuation lines are indented to it. An item begins with at most
    /// one blank line, so blank rows between the split line and the rest of
    /// the item are removed and returned to be written above the new marker.
    /// A marker that grows a digit moves indented rows with it.
    fn moved_item_rows(
        &self,
        line: &crate::inline::blocks::BlockLine,
        origin: &crate::inline::blocks::BlockLine,
        continuation: &str,
        opens_empty: bool,
    ) -> Result<(RowEdits, String), EditorError> {
        let list = origin.list.as_ref().unwrap();
        let end = line.list.as_ref().unwrap().item.end;
        let quote_end = super::indent_source::quote_prefix_end(continuation, list.quote_depth);
        let marker = &continuation[quote_end..].trim_start_matches([' ', '\t']);
        let width = marker.bytes().take_while(u8::is_ascii_digit).count().max(1)
            + usize::from(marker.starts_with(|c: char| c.is_ascii_digit()));
        let padding = marker[width..].bytes().take_while(|&b| b == b' ').count();
        let padding = if opens_empty || !(1..=4).contains(&padding) {
            1
        } else {
            padding
        };
        let column = list.marker_column + width + padding;
        let shift = column.saturating_sub(list.content_column);
        let mut edits = Vec::new();
        let mut lazy = opens_empty;
        let mut content = false;
        let mut blanks = String::new();
        let mut index = self.source.byte_to_line(line.source.start) + 1;
        while index < self.source.len_lines() && self.source.line_to_byte(index) < end {
            let start = self.source.line_to_byte(index);
            index += 1;
            let raw = self.source.line(index - 1).to_string();
            let text = raw.trim_end_matches(['\n', '\r']);
            let quotes = super::indent_source::quote_prefix_end(text, list.quote_depth);
            let body = &text[quotes..];
            if body.trim().is_empty() {
                if opens_empty && !content {
                    blanks.push_str(&raw);
                    edits.push((start..start + raw.len(), String::new()));
                }
                lazy = false;
                continue;
            }
            content = true;
            let indent = quotes + (body.len() - body.trim_start_matches([' ', '\t']).len());
            let at = crate::inline::columns(&text[..indent], 0);
            let wanted = if at >= list.content_column {
                lazy = false;
                at + shift
            } else if lazy {
                column
            } else {
                continue;
            };
            if wanted == at {
                continue;
            }
            // A lazy line may also omit its quote markers; it gains them.
            let full = text[..quotes].bytes().filter(|&b| b == b'>').count() == list.quote_depth;
            let (from, quote) = if full {
                (quotes, String::new())
            } else {
                (0, "> ".repeat(list.quote_depth))
            };
            if full && text[quotes..indent].contains('\t') {
                return Err(EditorError::UnrepresentableFormat);
            }
            let spaces = wanted
                .checked_sub(crate::inline::columns(&text[..from], 0) + quote.len())
                .ok_or(EditorError::UnrepresentableFormat)?;
            edits.push((
                start + from..start + indent,
                format!("{quote}{}", " ".repeat(spaces)),
            ));
        }
        if !content {
            // Blank rows with nothing after them stay where they are.
            edits.clear();
            blanks.clear();
        }
        Ok((edits, blanks))
    }

    /// Enter at a nonempty item's text start: an empty item of the same list
    /// opens above it and the caret stays on the item's text. `blank` (the
    /// item's quote markers and a line break) is staged above the item and the
    /// generic list edit turns it into the new item; both are one Undo step.
    fn enter_at_item_start(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        blank: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.stage_block_action(expected, range, None, accept, |staged, local, accept| {
            let lines = staged.projection.block_lines(local);
            let start = lines
                .first()
                .ok_or(EditorError::UnrepresentableFormat)?
                .source
                .start;
            let caret = start + blank.len() - 1;
            let staged_blank = staged.commit_block_key(
                staged.revision(),
                local,
                start..start,
                blank,
                caret,
                accept,
            )?;
            let Some(mut change) =
                staged.empty_item_above(staged.revision(), staged.selection(), accept)?
            else {
                return Ok(None);
            };
            accumulate_planning_work(&mut change.work, staged_blank.work);
            // The new item's line, then the original text on the next one.
            let display = &staged.projection.display;
            let line = display.byte_to_line(staged.selection().start.0);
            let text = DisplayOffset(display.line_to_byte(line + 1));
            staged.select(
                staged.revision(),
                DisplayRange {
                    start: text,
                    end: text,
                },
            )?;
            Ok(Some(change))
        })
    }
}
