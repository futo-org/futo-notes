//! Enter and Shift+Enter write the caret line's line ending.
use super::*;

impl EditorSession {
    /// On a CRLF line, runs the LF key action on a staged copy and spells each
    /// line break it wrote as CRLF, as one accepted edit and Undo step. A
    /// changed stretch that already held a bare LF (a mixed note) keeps the
    /// action's LF spelling.
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
        self.stage_block_action(expected, range, None, accept, |staged, local, accept| {
            let before = staged.source_text();
            let Some(change) = staged.lf_paragraph_key(staged.revision(), local, key, accept)?
            else {
                return Ok(None);
            };
            let after = staged.source_text();
            let prefix = before
                .bytes()
                .zip(after.bytes())
                .take_while(|(a, b)| a == b)
                .count();
            let suffix = before[prefix..]
                .bytes()
                .rev()
                .zip(after[prefix..].bytes().rev())
                .take_while(|(a, b)| a == b)
                .count();
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
            let caret = staged
                .source_at(staged.revision(), staged.selection().start, staged.affinity)?
                .0;
            let mut converted = String::with_capacity(changed.len() + breaks.len());
            let mut at = changed.start;
            for &lf in &breaks {
                converted.push_str(&after[at..lf]);
                converted.push_str("\r\n");
                at = lf + 1;
            }
            converted.push_str(&after[at..changed.end]);
            let shifted = caret + breaks.iter().filter(|&&lf| lf < caret).count();
            let formats = staged.pending_formats.clone();
            let affinity = staged.affinity;
            let mut second = staged.commit_block_edit(
                staged.revision(),
                changed,
                &converted,
                BlockSelection::Source(shifted),
                None,
                accept,
            )?;
            staged.carry_block_state(&mut second, formats, affinity);
            crate::session::transaction::accumulate_planning_work(&mut second.work, change.work);
            Ok(Some(second))
        })
    }
}
