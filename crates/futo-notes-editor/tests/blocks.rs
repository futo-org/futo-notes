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
#[path = "blocks/divider.rs"]
mod divider;
#[path = "blocks/keys.rs"]
mod keys;
#[path = "blocks/ownership.rs"]
mod ownership;
#[path = "blocks/projection.rs"]
mod projection;
#[path = "blocks/seams.rs"]
mod seams;
