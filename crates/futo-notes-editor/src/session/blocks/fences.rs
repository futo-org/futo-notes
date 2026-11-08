//! Fence commands own only their physical source region.
use super::*;

impl EditorSession {
    pub(in crate::session) fn fence_enter(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let Some(line) = self
            .projection
            .block_lines(range)
            .into_iter()
            .find(|line| line.code)
        else {
            return Ok(None);
        };
        let start = self.projection.display_at(line.content.start);
        if start > range.start.0 {
            return Ok(None);
        }
        let mut inserted = String::from("\n");
        inserted.extend(
            self.projection
                .display
                .byte_slice(start..range.start.0)
                .chars()
                .take_while(|ch| matches!(ch, ' ' | '\t')),
        );
        self.fence_input(
            expected,
            range,
            &inserted,
            crate::InputAction::Isolated,
            accept,
        )
    }

    pub(in crate::session) fn fence_conversion(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if range.start != range.end || !matches!(inserted, " " | "\n") {
            return Ok(None);
        }
        let Some(line) = self.projection.block_lines(range).into_iter().next() else {
            return Ok(None);
        };
        // A table row stays a row: its text is cells, not a line to convert;
        // a task's text is a paragraph after its checkbox, never a fence.
        if line.code
            || line.html
            || line.heading > 0
            || line.divider
            || line.task.is_some()
            || self.in_table(range)
        {
            return Ok(None);
        }
        let (inside, _) = self.projection.source_bounds(range.start.0);
        if self
            .projection
            .formats_at(inside)
            .contains(&InlineFormat::Code)
        {
            return Ok(None);
        }
        let start = self.projection.display_at(line.content.start);
        let prefix = self
            .projection
            .display
            .byte_slice(start..range.start.0)
            .to_string();
        let marker = prefix.as_bytes().first().copied().unwrap_or(0);
        let width = prefix.bytes().take_while(|&ch| ch == marker).count();
        if marker != b'`'
            || width != 3
            || prefix[width..].contains(char::is_whitespace)
            || prefix[width..].contains('`')
        {
            return Ok(None);
        }
        let quote = if line.list.is_some() || line.in_list {
            // Inside a list item the code rows continue the item: its quotes stay, and its
            // markers become the spaces that reach the item's content column.
            let row = self
                .source
                .line_to_byte(self.source.byte_to_line(line.content.start));
            self.source
                .byte_slice(row..line.content.start)
                .chars()
                .map(|ch| if matches!(ch, '>' | '\t') { ch } else { ' ' })
                .collect()
        } else {
            "> ".repeat(line.quote_depth)
        };
        let body = self
            .projection
            .display
            .byte_slice(range.start.0..self.projection.display_at(line.content.end))
            .to_string();
        let fence = (marker as char).to_string().repeat(width);
        let ending = self.line_ending_at(line.content.start);
        let output = format!("{prefix}{ending}{quote}{body}{ending}{quote}{fence}");
        let caret = line.content.start + prefix.len() + ending.len() + quote.len();
        self.commit_block_edit(
            expected,
            line.content.clone(),
            &output,
            BlockSelection::Source(caret),
            None,
            accept,
        )
        .map(Some)
    }
}

impl EditorSession {
    pub(in crate::session) fn fence_input(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let mut lines = self.projection.block_lines(range);
        // A note whose last block is a fence ends with the empty line after
        // its closing line ending; it shares the code's last display position,
        // where the caret is on the code.
        let end = self.source.len_bytes();
        if range.start == range.end && lines.iter().any(|line| line.fence.is_some()) {
            lines.retain(|line| line.fence.is_some() || line.source != (end..end));
        }
        if range.start == range.end
            && range == self.selection
            && self.affinity == Affinity::Backward
            && range.start.0 > 0
            && !lines.iter().any(|line| line.fence.is_some())
        {
            let previous =
                self.grapheme_stop(range.start.0, crate::CaretDirection::Backward, false)?;
            let preceding = self.projection.block_lines(DisplayRange {
                start: DisplayOffset(previous),
                end: range.end,
            });
            if preceding.iter().any(|line| {
                line.fence.as_ref().is_some_and(|fence| {
                    self.projection.display_at(fence.body.end) == range.start.0
                })
            }) {
                lines = preceding;
            }
        }
        let Some(line) = lines.iter().find(|line| line.fence.is_some()) else {
            return Ok(None);
        };
        let fence = line.fence.as_ref().unwrap();
        if lines.iter().any(|line| {
            line.fence
                .as_ref()
                .is_none_or(|other| other.whole != fence.whole)
        }) {
            return Ok(None);
        }
        if let Some(change) = self.fence_exit(expected, range, fence, inserted, accept)? {
            return Ok(Some(change));
        }
        let Some(owned) = fence.input_range(&self.projection, range, &lines, inserted) else {
            // Keep foreign code/prose separators with the strict generic planner.
            return Ok(None);
        };
        let (a, b) = (owned.source.start, owned.source.end);
        // An unchanged supplied code run owns its exact physical spelling,
        // including every hidden prefix inside it. Do not reconstruct those
        // rows from the first row's prefix. Still record the explicit action
        // through the same acceptance/history path as an empty replacement.
        if self
            .projection
            .display
            .byte_slice(range.start.0..range.end.0)
            == inserted
        {
            let caret = DisplayRange {
                start: range.end,
                end: range.end,
            };
            let code_end_caret = fence.closer.is_some()
                && range.end.0 == self.projection.display_at(fence.body.end)
                && range.start != range.end;
            let mut change = self.commit_block_edit(
                expected,
                a..a,
                "",
                BlockSelection::Display(caret),
                Some(HistoryInput {
                    range,
                    inserted,
                    action,
                }),
                accept,
            )?;
            if code_end_caret {
                self.carry_block_state(&mut change, None, Affinity::Backward);
            }
            return Ok(Some(change));
        }
        let prefix =
            if line.content.start <= fence.body.end && line.source.start >= fence.body.start {
                self.source
                    .byte_slice(line.source.start..line.content.start)
                    .to_string()
            } else {
                self.source
                    .byte_slice(
                        self.source
                            .line_to_byte(self.source.byte_to_line(fence.opener.start))
                            ..fence.opener.start,
                    )
                    .to_string()
            };
        let mut input = inserted.replace('\n', &format!("\n{prefix}"));
        if owned.continues_existing_row {
            // The selected ending survives in the replacement. Its following
            // physical prefix is still in source, with its exact own spelling.
            input.truncate(input.len() - prefix.len());
        }
        if fence.body.is_empty() {
            input.insert_str(0, &prefix);
            if fence.body.start == fence.whole.end
                && !self
                    .source
                    .byte_slice(fence.whole.clone())
                    .to_string()
                    .ends_with('\n')
            {
                input.insert(0, '\n');
            }
        }
        let added_ending = fence.separator.is_empty()
            && ((fence.closer.is_some() && a == fence.body.end) || inserted.ends_with('\n'));
        if added_ending {
            input.push('\n');
        }
        // Without a container prefix an unchanged body line can never read
        // as a closer (it would have ended the fence), so only the edited
        // lines can need a longer fence: a large block stays local (#314).
        let window = if prefix.is_empty() {
            let line = |at: usize| self.source.line_to_byte(self.source.byte_to_line(at));
            let start = line(a).max(fence.body.start);
            let end = (line(b) + self.source.line(self.source.byte_to_line(b)).len_bytes())
                .clamp(b, fence.body.end);
            start..end
        } else {
            fence.body.clone()
        };
        let body = self.source.byte_slice(window.clone()).to_string();
        let mut candidate = body.clone();
        candidate.replace_range(a - window.start..b - window.start, &input);
        let needed = candidate
            .lines()
            .filter_map(|line| {
                let raw = line.strip_prefix(&prefix).unwrap_or(line);
                let indentation = raw.bytes().take_while(|&ch| ch == b' ').count();
                if indentation > 3 {
                    return None;
                }
                let raw = &raw[indentation..];
                let width = raw.bytes().take_while(|&ch| ch == fence.marker).count();
                (width >= fence.width && raw[width..].trim_matches([' ', '\t']).is_empty())
                    .then_some(width + 1)
            })
            .max()
            .unwrap_or(fence.width);
        let caret = a + input.len() - usize::from(added_ending);
        let code_end_caret =
            fence.closer.is_some() && caret == fence.body.end + input.len() - (b - a);
        let (footprint, output, caret) = if needed > fence.width {
            let mut whole = self.source.byte_slice(fence.whole.clone()).to_string();
            if let Some(close) = fence.closer.as_ref().filter(|close| close.len() < needed) {
                whole.replace_range(
                    close.start - fence.whole.start..close.end - fence.whole.start,
                    &(fence.marker as char).to_string().repeat(needed),
                );
            }
            whole.replace_range(a - fence.whole.start..b - fence.whole.start, &input);
            whole.replace_range(
                fence.opener.start - fence.whole.start..fence.opener.end - fence.whole.start,
                &(fence.marker as char).to_string().repeat(needed),
            );
            (fence.whole.clone(), whole, caret + needed - fence.width)
        } else {
            (a..b, input, caret)
        };
        let materialized = body.len()
            + candidate.len()
            + prefix.len()
            + if needed > fence.width {
                fence.whole.len()
            } else {
                0
            };
        let mut change = self.commit_block_edit(
            expected,
            footprint,
            &output,
            BlockSelection::Source(caret),
            Some(HistoryInput {
                range,
                inserted,
                action,
            }),
            accept,
        )?;
        change.work.materialized_source_bytes += materialized;
        if code_end_caret {
            self.carry_block_state(&mut change, None, Affinity::Backward);
        }
        Ok(Some(change))
    }
}

impl EditorSession {
    /// Enter on the empty last line of a code block that closes the note
    /// leaves the block: nothing can be placed after such a block, so its
    /// last empty line becomes the empty line after the closing fence, at the
    /// block's own container level (a quote's `> `, a list item's indent).
    /// With anything after the block, that line stays code.
    fn fence_exit(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        fence: &crate::inline::fences::Fence,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let Some(closer) = fence.closer.as_ref() else {
            return Ok(None);
        };
        let len = self.source.len_bytes();
        let ending = self.fence_ending(fence);
        let prefix = self.closer_prefix(fence, closer);
        let after = self.source.byte_slice(closer.end..len).to_string();
        // The body ends in the code's own ending and the empty last row's
        // container prefix; the frame's terminal ending is the row's own.
        let last_row = format!("{ending}{prefix}");
        if inserted != "\n"
            || range.start != range.end
            || range.start.0 != self.projection.display_at(fence.body.end)
            || fence.body.len() < last_row.len()
            || !matches!(after.as_str(), "" | "\n" | "\r\n")
            || !self
                .source
                .byte_slice(fence.body.clone())
                .to_string()
                .ends_with(&last_row)
        {
            return Ok(None);
        }
        let start = fence.body.end - last_row.len();
        let marker = self.source.byte_slice(closer.clone()).to_string();
        // At the top level a note's trailing newline has no line to hold a
        // caret, so one more is written; a container's own prefix is a line.
        let tail = if prefix.is_empty() { ending } else { &prefix };
        let output = format!("{last_row}{marker}{ending}{tail}");
        let caret = start + output.len();
        let materialized = output.len() + (len - start);
        let mut change = self.commit_block_edit(
            expected,
            start..len,
            &output,
            BlockSelection::Source(caret),
            None,
            accept,
        )?;
        change.work.materialized_source_bytes += materialized;
        Ok(Some(change))
    }

    /// The fence's line ending, as its terminal body ending spells it.
    fn fence_ending(&self, fence: &crate::inline::fences::Fence) -> &'static str {
        if self.source.byte_slice(fence.separator.clone()).to_string() == "\r\n" {
            "\r\n"
        } else {
            "\n"
        }
    }

    /// The container prefix on the closing fence's row.
    fn closer_prefix(
        &self,
        fence: &crate::inline::fences::Fence,
        closer: &std::ops::Range<usize>,
    ) -> String {
        self.source
            .byte_slice(fence.separator.end..closer.start)
            .to_string()
    }

    /// The fence whose whole editable body a non-empty selection covers: from
    /// the first code character to the last, with or without the hidden
    /// terminal ending (a shell selecting a code block as one object).
    pub(in crate::session) fn selected_fence(
        &self,
        range: DisplayRange,
    ) -> Option<crate::inline::fences::Fence> {
        if range.start == range.end {
            return None;
        }
        let at = DisplayRange {
            start: range.start,
            end: range.start,
        };
        let fence = self
            .projection
            .block_lines(at)
            .into_iter()
            .find_map(|line| line.fence)?;
        let first = self.projection.display_at(fence.body.start);
        let last = self.projection.display_at(fence.body.end);
        let frame = self.projection.display_at(fence.separator.end).max(last);
        (!fence.body.is_empty() && range.start.0 == first && (last..=frame).contains(&range.end.0))
            .then_some(fence)
    }

    /// Enter with a code block selected as one object keeps the block and acts
    /// after it: an empty line below the closing fence, the caret on it. Like
    /// an image, a last block can always be left. An unclosed fence has no
    /// after; the caller treats Enter as a caret at the selection's end.
    pub(in crate::session) fn fence_selected_enter(
        &mut self,
        expected: Revision,
        fence: &crate::inline::fences::Fence,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let Some(closer) = fence.closer.as_ref() else {
            return Ok(None);
        };
        let len = self.source.len_bytes();
        let ending = self.fence_ending(fence);
        let prefix = self.closer_prefix(fence, closer);
        let rest = self.source.byte_slice(closer.end..len).to_string();
        let eol = if rest.starts_with("\r\n") {
            2
        } else {
            usize::from(rest.starts_with('\n'))
        };
        let at = closer.end + eol;
        // The closing row's own ending is already in the note, or it is not:
        // the new row needs one before it, and (at the top level, at the very
        // end) one after it, since a trailing newline holds no caret.
        let (text, caret) = match (eol, at == len, prefix.is_empty()) {
            (0, _, true) => (format!("{ending}{ending}"), at + 2 * ending.len()),
            (0, _, false) => (
                format!("{ending}{prefix}"),
                at + ending.len() + prefix.len(),
            ),
            (_, true, true) => (ending.to_owned(), at + ending.len()),
            (_, true, false) => (prefix.clone(), at + prefix.len()),
            _ => (format!("{prefix}{ending}"), at + prefix.len()),
        };
        let mut change = self.commit_block_edit(
            expected,
            at..at,
            &text,
            BlockSelection::Source(caret),
            None,
            accept,
        )?;
        change.work.materialized_source_bytes += text.len();
        Ok(Some(change))
    }
}
