use futo_notes_editor::{Revision, ViewChange};

/// Independent renderer: it holds display text only and understands no source
/// rules. Revision and byte-boundary checks catch malformed engine deltas.
pub struct ReferenceView {
    pub text: String,
    revision: Revision,
}

impl ReferenceView {
    pub fn new(text: &str) -> Self {
        Self {
            text: text.to_owned(),
            revision: Revision(0),
        }
    }

    pub fn apply(&mut self, change: ViewChange) {
        assert_eq!(change.previous_revision, self.revision);
        assert_eq!(change.revision.0, self.revision.0 + 1);
        self.text
            .replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert!(self.text.is_char_boundary(change.selection.start.0));
        assert!(self.text.is_char_boundary(change.selection.end.0));
        self.revision = change.revision;
    }
}

/// What the old list tests read of a list line, worked out from what the
/// surface now reports (its own indent and marker text). Deleted with those
/// tests at the cut-over.
#[allow(dead_code)]
pub trait OldListFields {
    fn depth(&self) -> usize;
    fn number(&self) -> Option<u64>;
}

impl OldListFields for futo_notes_editor::ListDescription {
    fn depth(&self) -> usize {
        self.indent / 2 + 1
    }

    fn number(&self) -> Option<u64> {
        self.marker.trim_end_matches(['.', ')']).parse().ok()
    }
}
