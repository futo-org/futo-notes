mod common;
use common::ReferenceView;
use futo_notes_editor::*;

fn range(a: usize, b: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(b),
    }
}

#[path = "lists/commands.rs"]
mod commands;
#[path = "lists/input.rs"]
mod input;
#[path = "lists/keys.rs"]
mod keys;
#[path = "lists/projection.rs"]
mod projection;
