//! Front matter is inert in the session: selections and edits stay in the body.
use super::*;

impl EditorSession {
    /// Front matter is inert: no edit starts inside it (only exact replay
    /// can). Typing after a closer at EOF first ends the closer's line.
    pub(super) fn prepare_source(
        &self,
        expected: Revision,
        range: SourceRange,
        inserted: &str,
    ) -> Result<SourceEdit, EditorError> {
        let metadata = self.projection.metadata_len();
        if metadata == 0 {
            return self.prepare_exact_source(expected, range, inserted);
        }
        if range.start.0 < metadata {
            self.check_revision(expected)?;
            return Err(EditorError::InvalidRange);
        }
        let open_closer = range.start.0 == metadata
            && metadata == self.source.len_bytes()
            && !matches!(self.source.byte(metadata - 1), b'\n' | b'\r');
        if open_closer && !inserted.is_empty() && !inserted.starts_with(['\n', '\r']) {
            let crlf = self
                .source
                .byte_slice(..metadata)
                .chars()
                .any(|ch| ch == '\r');
            let ending = if crlf { "\r\n" } else { "\n" };
            return self.prepare_exact_source(expected, range, &format!("{ending}{inserted}"));
        }
        self.prepare_exact_source(expected, range, inserted)
    }

    /// Endpoints inside front matter move to the body start; a selection
    /// starting at the note's start may still cover all of the metadata.
    pub(super) fn outside_metadata(&self, range: DisplayRange) -> DisplayRange {
        self.projection.outside_metadata(range)
    }

    /// Command input within front matter rejects; input covering it applies
    /// only to the body.
    pub(crate) fn body_range(&self, mut range: DisplayRange) -> Result<DisplayRange, EditorError> {
        let body = self.projection.body_start();
        if range.end.0 < body {
            return Err(EditorError::InvalidRange);
        }
        range.start.0 = range.start.0.max(body);
        Ok(range)
    }
}
