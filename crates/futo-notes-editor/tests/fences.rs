mod common;
use common::ReferenceView;
use futo_notes_editor::*;

fn range(a: usize, b: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(b),
    }
}

#[path = "fences/commands.rs"]
mod commands;
#[path = "fences/input.rs"]
mod input;
#[path = "fences/keys.rs"]
mod keys;
#[path = "fences/projection.rs"]
mod projection;
#[path = "fences/protected_input.rs"]
mod protected_input;
