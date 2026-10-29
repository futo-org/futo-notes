//! Shared block commands. Hosts supply visible ranges and never spell Markdown.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlockCommand {
    /// Zero selects plain paragraph text; one through six select a heading.
    Heading(u8),
    Quote,
    Indent,
    Outdent,
    Divider,
}

impl EditorSession {
    pub fn block_command_utf16(
        &mut self,
        expected: Revision,
        range: crate::DisplayUtf16Range,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (range, _) = self.decode_utf16_input(expected, range, &[])?;
        self.block_command(expected, range, command, accept)
    }

    pub fn block_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        self.validate_range(range)?;
        if matches!(command, BlockCommand::Heading(level) if level > 6) {
            return Err(EditorError::InvalidRange);
        }
        let lines = self.projection.block_lines(range);
        let Some(first) = lines.first() else {
            return Ok(None);
        };
        if command == BlockCommand::Divider {
            if lines.iter().any(|line| line.code) {
                return Ok(None);
            }
            let start = first.source.start;
            let last = lines.last().unwrap();
            let end = last.content.end;
            let body = self.source.byte_slice(first.content.start..end).to_string();
            let mut staged = Self::open_with_clock(&body, self.clock.clone());
            let display_start = self.projection.display_at(first.content.start);
            let local = DisplayRange {
                start: DisplayOffset(range.start.0 - display_start),
                end: DisplayOffset(range.end.0 - display_start),
            };
            staged.replace_action(
                staged.revision(),
                local,
                "\n\n",
                crate::InputAction::Isolated,
                &mut |_| Ok(()),
            )?;
            let body = staged.source_text();
            let split = body
                .find("\n\n")
                .ok_or(EditorError::UnrepresentableFormat)?;
            let left = &body[..split];
            let right = &body[split + 2..];
            let quote = "> ".repeat(first.quote_depth);
            let prefix = self
                .source
                .byte_slice(first.source.start..first.content.start)
                .to_string();
            let lead = if left.is_empty() {
                String::new()
            } else {
                format!("{prefix}{left}\n")
            };
            let marker = if left.is_empty() { "---" } else { "***" };
            let mut output = format!("{lead}{quote}{marker}\n");
            let caret = start + output.len();
            if !right.is_empty() {
                output.push_str(&format!("{quote}\n{quote}{right}"));
            }
            return self
                .commit_block_edit(expected, start..end, &output, None, Some(caret), accept)
                .map(Some);
        }
        let end = lines.last().unwrap().source.end;
        let start = first.source.start;
        let raw = self.source.byte_slice(start..end).to_string();
        let mut output = raw.clone();
        for line in lines.iter().rev() {
            if line.code
                || line.divider
                || matches!(command, BlockCommand::Heading(level) if line.heading == level)
            {
                continue;
            }
            let prefix = self
                .source
                .byte_slice(line.source.start..line.content.start)
                .to_string();
            let quote_prefix = prefix.find('#').map_or(prefix.as_str(), |at| &prefix[..at]);
            let replacement = match command {
                BlockCommand::Heading(level) => format!(
                    "{quote_prefix}{}",
                    if level == 0 {
                        String::new()
                    } else {
                        format!("{} ", "#".repeat(level as usize))
                    }
                ),
                BlockCommand::Quote if line.quote_depth == 0 => format!("> {quote_prefix}"),
                BlockCommand::Indent if line.quote_depth > 0 => format!("> {prefix}"),
                BlockCommand::Outdent if line.quote_depth > 0 => {
                    let at = prefix.find('>').unwrap_or(0);
                    let mut cut = at + 1;
                    if matches!(prefix.as_bytes().get(cut), Some(b' ' | b'\t')) {
                        cut += 1;
                    }
                    prefix[cut..].to_owned()
                }
                _ => continue,
            };
            // Changing heading level retires only that line's optional ATX closer.
            if matches!(command, BlockCommand::Heading(_))
                || command == BlockCommand::Quote && line.heading > 0
            {
                let content_end = line.source.end
                    - self
                        .source
                        .byte_slice(line.source.clone())
                        .to_string()
                        .len()
                    + self
                        .source
                        .byte_slice(line.source.clone())
                        .to_string()
                        .trim_end_matches(['\r', '\n'])
                        .len();
                output.replace_range(line.content.end - start..content_end - start, "");
            }
            output.replace_range(
                line.source.start - start..line.content.start - start,
                &replacement,
            );
        }
        if output == raw {
            return Ok(None);
        }
        let mut selection = range;
        if matches!(command, BlockCommand::Quote | BlockCommand::Indent)
            && end < self.source.len_bytes()
        {
            let next_display = self.projection.display_at(end);
            let next_range = DisplayRange {
                start: DisplayOffset(next_display),
                end: DisplayOffset(next_display),
            };
            if let Some(next) = self.projection.block_lines(next_range).first() {
                let target_depth = first.quote_depth + 1;
                if !next.content.is_empty()
                    && next.quote_depth < target_depth
                    && next.heading == 0
                    && !next.divider
                    && !next.code
                {
                    output.push_str(&format!("{}\n", "> ".repeat(first.quote_depth).trim_end()));
                }
            }
        }
        if command == BlockCommand::Outdent && first.quote_depth > 0 && first.source.start > 0 {
            let previous_display = self
                .projection
                .display_at(first.source.start)
                .saturating_sub(1);
            let previous_range = DisplayRange {
                start: DisplayOffset(previous_display),
                end: DisplayOffset(previous_display),
            };
            // Query at the preceding newline (ASCII boundary), never inside Unicode text.
            if self
                .projection
                .block_lines(previous_range)
                .first()
                .is_some_and(|previous| previous.quote_depth >= first.quote_depth)
            {
                output.insert_str(
                    0,
                    &format!("{}\n", "> ".repeat(first.quote_depth - 1).trim_end()),
                );
                selection.start.0 += 1;
                selection.end.0 += 1;
            }
        }
        self.commit_block_edit(expected, start..end, &output, Some(selection), None, accept)
            .map(Some)
    }

    pub(super) fn line_start_conversion(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if range.start != range.end {
            return Ok(None);
        }
        let Some(line) = self.projection.block_lines(range).into_iter().next() else {
            return Ok(None);
        };
        if line.code || line.heading > 0 || line.divider {
            return Ok(None);
        }
        let start_display = self.projection.display_at(line.content.start);
        let mut prefix = self
            .projection
            .display
            .byte_slice(start_display..range.start.0)
            .to_string();
        prefix.push_str(inserted);
        let heading = prefix
            .strip_suffix(' ')
            .filter(|s| !s.is_empty() && s.len() <= 6 && s.bytes().all(|ch| ch == b'#'));
        let quote = prefix == "> ";
        let divider = matches!(prefix.as_str(), "---" | "___ " | "*** ")
            && range.start.0 == self.projection.display_at(line.content.end);
        if heading.is_none() && !quote && !divider {
            return Ok(None);
        }
        let at = self.source_at(expected, range.start, Affinity::Backward)?.0;
        let replacement = if divider {
            let index = self.source.byte_to_line(line.source.start);
            let previous_nonempty =
                index > 0 && !self.source.line(index - 1).to_string().trim().is_empty();
            format!("{}\n", if previous_nonempty { "***" } else { "---" })
        } else {
            prefix
        };
        let caret = line.content.start + replacement.len();
        self.commit_block_edit(
            expected,
            line.content.start..at,
            &replacement,
            None,
            Some(caret),
            accept,
        )
        .map(Some)
    }

    pub(super) fn structural_key(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        key: ParagraphKey,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if range.start != range.end {
            return Ok(None);
        }
        let Some(line) = self.projection.block_lines(range).into_iter().next() else {
            return Ok(None);
        };
        if line.code {
            return Ok(None);
        }
        let start_display = self.projection.display_at(line.content.start);
        let at_start = range.start.0 == start_display;
        let prefix = self
            .source
            .byte_slice(line.source.start..line.content.start)
            .to_string();
        if key == ParagraphKey::Backspace && at_start && (line.heading > 0 || line.quote_depth > 0)
        {
            let command = if line.heading > 0 {
                BlockCommand::Heading(0)
            } else {
                BlockCommand::Outdent
            };
            return self.block_command(expected, range, command, accept);
        }
        if !matches!(key, ParagraphKey::Enter | ParagraphKey::ShiftEnter) {
            return Ok(None);
        }
        if line.heading == 0 && line.quote_depth == 0 && !line.divider {
            return Ok(None);
        }
        if line.content.is_empty() && line.quote_depth > 0 {
            let index = self.source.byte_to_line(line.source.start);
            if index > 0 {
                let previous_start = self.source.line_to_byte(index - 1);
                let previous = self
                    .source
                    .byte_slice(previous_start..line.source.start)
                    .to_string();
                if previous.trim_end_matches(['\r', '\n']).trim()
                    == "> ".repeat(line.quote_depth).trim()
                {
                    let quote = "> ".repeat(line.quote_depth - 1);
                    let output = format!("{}\n{quote}", quote.trim_end());
                    let caret = previous_start + output.len();
                    return self
                        .commit_block_edit(
                            expected,
                            previous_start..line.content.end,
                            &output,
                            None,
                            Some(caret),
                            accept,
                        )
                        .map(Some);
                }
            }
            return self.block_command(expected, range, BlockCommand::Outdent, accept);
        }
        if at_start && (line.heading > 0 || line.quote_start || line.divider) {
            return self
                .commit_block_edit(
                    expected,
                    line.source.start..line.source.start,
                    "\n",
                    None,
                    Some(line.source.start + 1),
                    accept,
                )
                .map(Some);
        }
        if line.divider {
            let at = line.content.end;
            return self
                .commit_block_edit(expected, at..at, "\n", None, Some(at + 1), accept)
                .map(Some);
        }
        let raw = self.source.byte_slice(line.content.clone()).to_string();
        let mut staged = Self::open_with_clock(&raw, self.clock.clone());
        let offset = range.start.0 - start_display;
        let local = DisplayRange {
            start: DisplayOffset(offset),
            end: DisplayOffset(offset),
        };
        // A heading ends its inline block at Enter. A temporary blank line asks
        // the inline owner to close/reopen its spans before splitting that block.
        let separator = "\n\n";
        staged.replace_action(
            staged.revision(),
            local,
            separator,
            crate::InputAction::Isolated,
            &mut |_| Ok(()),
        )?;
        let mut body = staged.source_text();
        let split = body
            .find(separator)
            .ok_or(EditorError::UnrepresentableFormat)?;
        body.remove(split + 1);
        let suffix_end = line.source.start
            + self
                .source
                .byte_slice(line.source.clone())
                .to_string()
                .trim_end_matches(['\r', '\n'])
                .len();
        let suffix = self
            .source
            .byte_slice(line.content.end..suffix_end)
            .to_string();
        let continuation = if line.quote_depth > 0 {
            "> ".repeat(line.quote_depth)
        } else {
            String::new()
        };
        let separator = if line.quote_depth > 0 && line.heading == 0 {
            format!("{}\n", continuation.trim_end())
        } else {
            String::new()
        };
        let output = format!(
            "{prefix}{}{}\n{separator}{continuation}{}",
            &body[..split],
            suffix,
            &body[split + 1..]
        );
        let caret = line.source.start
            + prefix.len()
            + split
            + suffix.len()
            + 1
            + separator.len()
            + continuation.len();
        self.commit_block_edit(
            expected,
            line.source.start..suffix_end,
            &output,
            None,
            Some(caret),
            accept,
        )
        .map(Some)
    }

    fn commit_block_edit(
        &mut self,
        expected: Revision,
        range: std::ops::Range<usize>,
        inserted: &str,
        selection: Option<DisplayRange>,
        source_caret: Option<usize>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let edit = self.prepare_source(
            expected,
            SourceRange {
                start: SourceOffset(range.start),
                end: SourceOffset(range.end),
            },
            inserted,
        )?;
        accept(&edit).map_err(EditorError::Persistence)?;
        let before_selection = self.selection;
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let mut change = self.apply(&edit);
        if let Some(selection) = selection {
            self.selection = selection;
        }
        if let Some(source) = source_caret {
            let at = DisplayOffset(self.projection.display_at(source));
            self.selection = DisplayRange { start: at, end: at };
        }
        self.pending_formats = None;
        change.selection = self.selection;
        change.work.materialized_source_bytes += inserted.len();
        self.undo.push(HistoryGroup {
            entries: vec![HistoryEntry {
                before_selection,
                before_affinity,
                before_formats,
                after_selection: self.selection,
                after_affinity: self.affinity,
                after_formats: None,
                range: edit.range,
                removed: edit.removed,
                inserted: edit.inserted,
            }],
        });
        self.redo.clear();
        self.typing = None;
        Ok(change)
    }
}
