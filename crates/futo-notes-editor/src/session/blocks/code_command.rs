//! The code-block command converts eligible physical lines independently.
use super::*;

struct CodeLine {
    source: std::ops::Range<usize>,
    display: std::ops::Range<usize>,
    inserted: String,
    body_start: usize,
}

impl EditorSession {
    pub(super) fn code_block_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let lines = self.projection.block_lines(range);
        if let Some(change) = self.code_toggle_off(expected, range, &lines, accept)? {
            return Ok(Some(change));
        }
        if lines.iter().any(|line| line.heading > 0 && !line.in_list) {
            return self.stage_block_action(
                expected,
                range,
                None,
                accept,
                |staged, local, accept| {
                    let plain = staged.block_command(
                        staged.revision(),
                        local,
                        BlockCommand::Heading(0),
                        accept,
                    )?;
                    let mut converted =
                        staged.code_block_command(staged.revision(), local, accept)?;
                    if let (Some(plain), Some(converted)) = (plain, &mut converted) {
                        converted.work.materialized_source_bytes +=
                            plain.work.materialized_source_bytes;
                        converted.work.parsed_source_bytes += plain.work.parsed_source_bytes;

                        converted.work.link_metadata_items += plain.work.link_metadata_items;

                        converted.work.link_copied_bytes += plain.work.link_copied_bytes;
                    }
                    Ok(converted)
                },
            );
        }
        let mut edits = Vec::new();
        for line in lines
            .iter()
            .filter(|line| !line.code && !line.in_list && !line.divider)
        {
            if range.start != range.end && line.content.is_empty() {
                continue;
            }
            let display = self.projection.display_at(line.content.start)
                ..self.projection.display_at(line.content.end);
            let text = self
                .projection
                .display
                .byte_slice(display.clone())
                .to_string();
            let width = text
                .as_bytes()
                .split(|&ch| ch != b'`')
                .map(<[u8]>::len)
                .max()
                .unwrap_or(0)
                .saturating_add(1)
                .max(3);
            let marker = "`".repeat(width);
            let prefix = self
                .source
                .byte_slice(line.source.start..line.content.start)
                .to_string();
            let mut inserted = format!("{prefix}{marker}\n{prefix}{text}\n{prefix}{marker}");
            // Separate neighboring newly authored code blocks, retaining the
            // original physical break alongside this new paragraph separator.
            if lines.iter().any(|next| {
                next.source.start == line.source.end
                    && !next.code
                    && !next.in_list
                    && !next.content.is_empty()
            }) {
                inserted.push('\n');
            }
            let physical = self.source.byte_slice(line.source.clone()).to_string();
            let end = line.source.start + physical.trim_end_matches(['\r', '\n']).len();
            edits.push(CodeLine {
                source: line.source.start..end,
                display,
                inserted,
                body_start: 2 * prefix.len() + marker.len() + 1,
            });
        }
        let Some(first) = edits.first() else {
            return Ok(None);
        };
        let footprint = first.source.start..edits.last().unwrap().source.end;
        let mut output = self.source.byte_slice(footprint.clone()).to_string();
        for edit in edits.iter().rev() {
            output.replace_range(
                edit.source.start - footprint.start..edit.source.end - footprint.start,
                &edit.inserted,
            );
        }
        let map = |point: usize| {
            let original = self.projection.source_bounds(point).1;
            let mut shift = 0isize;
            for edit in &edits {
                if edit.display.start <= point && point <= edit.display.end {
                    return (edit.source.start as isize + shift) as usize + edit.body_start + point
                        - edit.display.start;
                }
                if edit.source.end <= original {
                    shift += edit.inserted.len() as isize - edit.source.len() as isize;
                }
            }
            (original as isize + shift) as usize
        };
        let selected = map(range.start.0)..map(range.end.0);
        let materialized =
            footprint.len() + edits.iter().map(|edit| edit.inserted.len()).sum::<usize>();
        let mut change = self.commit_block_edit(
            expected,
            footprint,
            &output,
            BlockSelection::SourceRange(selected),
            None,
            accept,
        )?;
        change.work.materialized_source_bytes += materialized;
        Ok(Some(change))
    }
}

impl EditorSession {
    /// The command on lines that are all already code takes the touched rows
    /// out of their fence: the rows above and below stay fenced (each part
    /// keeps the opener's spelling), and the displayed text does not move.
    fn code_toggle_off(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        lines: &[crate::inline::blocks::BlockLine],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let Some(fence) = lines.first().and_then(|line| line.fence.as_ref()) else {
            return Ok(None);
        };
        if lines
            .iter()
            .any(|line| !line.code || line.fence.as_ref().is_none_or(|f| f.whole != fence.whole))
        {
            return Ok(None);
        }
        let row_start = |at: usize| self.source.line_to_byte(self.source.byte_to_line(at));
        let start = row_start(fence.whole.start);
        let rest = self
            .source
            .byte_slice(fence.whole.end..self.source.len_bytes())
            .to_string();
        let end = fence.whole.end
            + if rest.starts_with("\r\n") {
                2
            } else {
                usize::from(rest.starts_with('\n'))
            };
        let prefix = self
            .source
            .byte_slice(start..fence.opener.start)
            .to_string();
        let region = self.source.byte_slice(start..end).to_string();
        let mut rows: Vec<(usize, &str)> = Vec::new();
        let mut at = start;
        for row in region.split_inclusive('\n') {
            rows.push((at, row));
            at += row.len();
        }
        let split = |row: &str| {
            let text = row.trim_end_matches(['\r', '\n']);
            (text.to_owned(), row[text.len()..].to_owned())
        };
        let closed = fence.closer.is_some();
        let body_rows = rows.len() - 1 - usize::from(closed);
        let first = lines
            .iter()
            .map(|line| line.source.start)
            .min()
            .unwrap_or(0);
        let last = lines
            .iter()
            .map(|line| line.source.start)
            .max()
            .unwrap_or(0);
        let touched = |index: usize| {
            let at = rows[index + 1].0;
            first <= at && at <= last
        };
        let opener = split(rows[0].1).0;
        let closer = if closed {
            split(rows[rows.len() - 1].1).0
        } else {
            format!(
                "{prefix}{}",
                (fence.marker as char).to_string().repeat(fence.width)
            )
        };
        let tail = split(rows[rows.len() - 1].1).1;
        let eol = if rows[0].1.ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let mut out: Vec<String> = Vec::new();
        let mut section: Vec<String> = Vec::new();
        let flush = |section: &mut Vec<String>, out: &mut Vec<String>| {
            if !section.is_empty() {
                out.push(opener.clone());
                out.append(section);
                out.push(closer.clone());
            }
        };
        for index in 0..body_rows {
            let text = split(rows[index + 1].1).0;
            if touched(index) {
                flush(&mut section, &mut out);
                // The row is prose now: its text must not read as Markdown.
                let row_start = rows[index + 1].0;
                let content = lines
                    .iter()
                    .find(|line| line.source.start == row_start)
                    .map_or(0, |line| line.content.start - row_start)
                    .min(text.len());
                out.push(format!(
                    "{}{}",
                    &text[..content],
                    prose_literal(&text[content..])
                ));
            } else {
                section.push(text);
            }
        }
        // An unclosed fence keeps its tail open.
        if !closed && !section.is_empty() {
            out.push(opener.clone());
            out.append(&mut section);
        } else {
            flush(&mut section, &mut out);
        }
        let mut output = out.join(eol);
        if !out.is_empty() {
            output.push_str(&tail);
        }
        if output == region {
            return Ok(None);
        }
        let mut change = self.commit_block_edit(
            expected,
            start..end,
            &output,
            BlockSelection::Display(range),
            None,
            accept,
        )?;
        change.work.materialized_source_bytes += region.len() + output.len();
        Ok(Some(change))
    }
}

/// Code text spelled so it stays plain text as a paragraph row: block syntax
/// is kept literal as the block commands keep it, and leading whitespace,
/// which a paragraph drops, is encoded.
fn prose_literal(text: &str) -> String {
    // Literal prose must not acquire inline formatting or table structure.
    // Write those syntax characters as numeric entities.
    let literal: String = text
        .chars()
        .map(|ch| {
            if matches!(
                ch,
                '\\' | '*' | '_' | '~' | '`' | '[' | ']' | '<' | '&' | '|'
            ) {
                format!("&#{};", ch as u32)
            } else {
                ch.to_string()
            }
        })
        .collect();
    let (mut text, _) = super::content::protect_content(&literal, false, true);
    // Paragraph parsing drops trailing whitespace, unlike code. Keep it visible
    // so the unchanged display selection is still valid after removing fences.
    let tail = text.trim_end_matches([' ', '\t']).len();
    if tail < text.len() {
        let encoded: String = text[tail..]
            .chars()
            .map(|ch| format!("&#{};", ch as u32))
            .collect();
        text.replace_range(tail.., &encoded);
    }
    if let Some(first @ (' ' | '\t')) = text.chars().next() {
        text.replace_range(..1, &format!("&#{};", first as u32));
    }
    text
}

impl EditorSession {
    /// The text-first toolbar authors one fence for the complete selected
    /// display rows. Unlike the portable per-line command, mixed structures
    /// are flattened to opaque text in this single accepted edit.
    pub(super) fn wrap_code_block(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let lines = self.projection.block_lines(range);
        if let Some(change) = self.code_toggle_off(expected, range, &lines, accept)? {
            return Ok(Some(change));
        }
        let Some(first) = lines.first() else {
            return Ok(None);
        };
        let last = lines.last().unwrap();
        let start = first.fence.as_ref().map_or(first.source.start, |f| {
            self.source
                .line_to_byte(self.source.byte_to_line(f.whole.start))
        });
        let end = last.fence.as_ref().map_or(last.source.end, |f| f.whole.end);
        let physical = self.source.byte_slice(start..end).to_string();
        let ending = &physical[physical.trim_end_matches(['\r', '\n']).len()..];
        let shown_start = self.projection.display_at(start);
        let shown_end = self.projection.display_at(end);
        let shown = self
            .projection
            .display
            .byte_slice(shown_start..shown_end)
            .to_string();
        // Keep the physical final ending outside the hidden fence frame, so
        // selecting the parked final empty line does not add a blank code row.
        let text = shown
            .strip_suffix(ending)
            .filter(|_| !ending.is_empty())
            .unwrap_or(&shown);
        let width = text
            .as_bytes()
            .split(|&ch| ch != b'`')
            .map(<[u8]>::len)
            .max()
            .unwrap_or(0)
            .saturating_add(1)
            .max(3);
        let marker = "`".repeat(width);
        let prefix = if lines
            .iter()
            .all(|line| line.quote_depth == first.quote_depth && !line.in_list)
        {
            "> ".repeat(first.quote_depth)
        } else {
            String::new()
        };
        let body = text.replace('\n', &format!("\n{prefix}"));
        let inserted = format!("{prefix}{marker}\n{prefix}{body}\n{prefix}{marker}{ending}");
        let body_start = start + prefix.len() * 2 + marker.len() + 1;
        let map = |point: usize| {
            let within = (point - shown_start).min(text.len());
            body_start
                + within
                + prefix.len() * text[..within].bytes().filter(|&ch| ch == b'\n').count()
                + point.saturating_sub(shown_start + text.len())
        };
        let selected = map(range.start.0)..map(range.end.0);
        let mut change = self.commit_block_edit(
            expected,
            start..end,
            &inserted,
            BlockSelection::SourceRange(selected),
            None,
            accept,
        )?;
        change.work.materialized_source_bytes += physical.len() + shown.len() + inserted.len();
        Ok(Some(change))
    }
}
