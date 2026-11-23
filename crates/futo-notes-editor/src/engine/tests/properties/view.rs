//! A renderer's copy of the display, kept by the changes the engine returns.
use crate::engine::edit::Change;
use crate::ViewChange;

/// A renderer's copy of the display, the windows it restyled and the
/// changes it applied since the last check.
#[derive(Default)]
pub(in crate::engine::tests) struct View {
    pub text: String,
    /// The display range of each change's lines since the last check.
    pub restyled: Vec<std::ops::Range<usize>>,
    /// Changes applied as the core returns them; the session makes each a
    /// `ViewChange` at once (`Engine::view`).
    pub edits: Vec<Change>,
    pub view_changes: Vec<ViewChange>,
}

impl View {
    pub fn new(text: String) -> Self {
        Self {
            text,
            ..Self::default()
        }
    }
}

/// Apply a change to a copy of the display, as a renderer would.
pub(in crate::engine::tests) fn apply_view(view: &mut View, change: &Change) {
    view.text
        .replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    view.restyled.push(change.lines.clone());
    view.edits.push(change.clone());
}

/// Apply a view change to a copy of the display, as a renderer would.
pub(super) fn apply_view_change(view: &mut View, change: &ViewChange) {
    view.text
        .replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    let lines = &change.projection.range;
    view.restyled.push(lines.start.0..lines.end.0);
    view.view_changes.push(change.clone());
}
