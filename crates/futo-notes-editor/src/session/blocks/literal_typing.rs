//! The last resort that keeps a typed character from ever being refused.
use super::*;

impl EditorSession {
    /// Writes typed text at a collapsed caret as literal source: ASCII
    /// punctuation is a numeric entity (code keeps it as typed), so nothing
    /// typed can open, close or pair inline syntax; unlike a backslash escape,
    /// an entity cannot close a code span an unmatched backtick opened. Used only when every
    /// spelling the inline planner tries is refused; the parser then reads the
    /// row as written, the way typing reads at a top-level line.
    pub(in crate::session) fn literal_typing(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        // Table input keeps its own pipe rules and refusals.
        if range.start != range.end || inserted.contains(['\r', '\n']) || self.in_table(range) {
            return Err(EditorError::UnrepresentableFormat);
        }
        let line = self
            .projection
            .block_lines(range)
            .into_iter()
            .next()
            .ok_or(EditorError::UnrepresentableFormat)?;
        if line.code || line.html || line.metadata {
            return Err(EditorError::UnrepresentableFormat);
        }
        let (low, high) = self.projection.source_bounds(range.start.0);
        let at = if self.input_affinity(range) == Affinity::Backward && low >= line.content.start {
            low
        } else {
            high.max(line.content.start)
        };
        let code = self.projection.formats_at(at).contains(&InlineFormat::Code);
        let text: String = inserted
            .chars()
            .map(|ch| {
                if !code && ch.is_ascii_punctuation() {
                    format!("&#{};", ch as u32)
                } else {
                    ch.to_string()
                }
            })
            .collect();
        self.commit_block_edit(
            expected,
            at..at,
            &text,
            BlockSelection::Source(at + text.len()),
            Some(HistoryInput {
                range,
                inserted,
                action,
            }),
            accept,
        )
    }
}
