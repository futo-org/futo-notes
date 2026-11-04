mod common;
use common::ReferenceView;
use futo_notes_editor::*;
fn range(a: usize, b: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(b),
    }
}
#[path = "blocks/commands.rs"]
mod commands;
#[path = "blocks/composition.rs"]
mod composition;
#[path = "blocks/conversions.rs"]
mod conversions;
#[path = "blocks/keys.rs"]
mod keys;
#[path = "blocks/projection.rs"]
mod projection;
#[path = "blocks/quote_enter.rs"]
mod quote_enter;
#[path = "blocks/seams.rs"]
mod seams;
#[path = "blocks/selected_source.rs"]
mod selected_source;
#[path = "blocks/toggle.rs"]
mod toggle;

#[path = "blocks/heading_join.rs"]
mod heading_join;
