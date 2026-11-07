use super::{plan_styles, plan_tables, DisplayMirror, StyleSpec};
use crate::QuickOpen;

/// The spans to draw for a long note's quick first screens, in UTF-16 units of their display
/// (which is the start of the whole display): the style plan of the projection and its tables,
/// exactly as a session over the whole note plans that range.
pub fn plan_quick_open(quick: &QuickOpen) -> Vec<StyleSpec> {
    let mirror = DisplayMirror::new(&quick.display);
    let end = mirror.utf16_len();
    // A block may reach past the shown text; it ends at the cut.
    let mut to_utf16 = |byte: usize| mirror.byte_to_utf16(byte).unwrap_or(end);
    let mut spans = plan_styles(&quick.projection, 0, &mut to_utf16);
    spans.extend(plan_tables(&quick.tables, &mut to_utf16));
    spans
}
