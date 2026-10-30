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
