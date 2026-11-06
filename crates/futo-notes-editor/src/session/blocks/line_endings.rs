//! Enter, Shift+Enter and the block commands that write new lines (divider,
//! code block) write the caret line's line ending.
use super::*;

impl EditorSession {
    /// On a CRLF line, runs the LF key action on a staged copy and spells each
    /// line break it wrote as CRLF, as one accepted edit and Undo step.
    pub(in crate::session) fn crlf_enter(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        key: ParagraphKey,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        // A table cell's keys move between cells or add rows that already
        // copy the neighboring row's line ending.
        if self.in_table_cell(range) {
            return self.lf_paragraph_key(expected, range, key, accept);
        }
        self.in_caret_line_ending(expected, range, accept, |staged, local, accept| {
            staged.lf_paragraph_key(staged.revision(), local, key, accept)
        })
    }

    /// The divider and code-block commands, whose new lines are written by
    /// their own owners, on a CRLF line.
    pub(in crate::session) fn crlf_block_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.in_caret_line_ending(expected, range, accept, |staged, local, accept| {
            staged.lf_block_command(staged.revision(), local, command, accept)
        })
    }

    /// Runs an action that writes LF line breaks on a staged copy, then
    /// spells each break it wrote as CRLF in the same accepted edit and Undo
    /// step. A changed stretch that already held a bare LF (a mixed note)
    /// keeps the action's LF spelling. The action must edit source whenever it
    /// returns a change.
    fn in_caret_line_ending(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        action: impl FnOnce(
            &mut Self,
            DisplayRange,
            &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        ) -> Result<Option<ViewChange>, EditorError>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.stage_block_action(expected, range, None, accept, |staged, local, accept| {
            let before = staged.source_text();
            let Some(change) = action(staged, local, accept)? else {
                return Ok(None);
            };
            let after = staged.source_text();
            let prefix = before
                .bytes()
                .zip(after.bytes())
                .take_while(|(a, b)| a == b)
                .count();
            let mut suffix = before[prefix..]
                .bytes()
                .rev()
                .zip(after[prefix..].bytes().rev())
                .take_while(|(a, b)| a == b)
                .count();
            // A shared final LF the action left bare (its CR replaced) is one
            // of its breaks too.
            while suffix > 0 && {
                let at = after.len() - suffix;
                after.as_bytes()[at] == b'\n' && (at == 0 || after.as_bytes()[at - 1] != b'\r')
            } {
                suffix -= 1;
            }
            let changed = prefix..after.len() - suffix;
            let bare = |text: &str, range: std::ops::Range<usize>| {
                range
                    .filter(|&at| {
                        text.as_bytes()[at] == b'\n'
                            && (at == 0 || text.as_bytes()[at - 1] != b'\r')
                    })
                    .collect::<Vec<_>>()
            };
            if !bare(&before, prefix..before.len() - suffix).is_empty() {
                return Ok(Some(change));
            }
            let breaks = bare(&after, changed.clone());
            if breaks.is_empty() {
                return Ok(Some(change));
            }
            let selection = staged.selection();
            let caret = staged
                .source_at(staged.revision(), selection.start, staged.affinity)?
                .0;
            let selected_end = staged
                .source_at(staged.revision(), selection.end, staged.affinity)?
                .0;
            let mut converted = String::with_capacity(changed.len() + breaks.len());
            let mut at = changed.start;
            for &lf in &breaks {
                converted.push_str(&after[at..lf]);
                converted.push_str("\r\n");
                at = lf + 1;
            }
            converted.push_str(&after[at..changed.end]);
            let shift = |at: usize| at + breaks.iter().filter(|&&lf| lf < at).count();
            let shifted = shift(caret);
            let selected = if selected_end == caret {
                BlockSelection::Source(shifted)
            } else {
                BlockSelection::SourceRange(shifted..shift(selected_end))
            };
            let formats = staged.pending_formats.clone();
            let affinity = staged.affinity;
            let mut second = staged.commit_block_edit(
                staged.revision(),
                changed,
                &converted,
                selected,
                None,
                accept,
            )?;
            staged.carry_block_state(&mut second, formats, affinity);
            crate::session::transaction::accumulate_planning_work(&mut second.work, change.work);
            Ok(Some(second))
        })
    }
}
