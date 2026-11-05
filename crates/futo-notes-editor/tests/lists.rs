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
#[path = "lists/comment_seams.rs"]
mod comment_seams;
#[path = "lists/containers.rs"]
mod containers;
#[path = "lists/enter_at_start.rs"]
mod enter_at_start;
#[path = "lists/fixtures.rs"]
mod fixtures;
#[path = "lists/input.rs"]
mod input;
#[path = "lists/keys.rs"]
mod keys;
#[path = "lists/lifting.rs"]
mod lifting;
#[path = "lists/mixed_commands.rs"]
mod mixed_commands;
#[path = "lists/projection.rs"]
mod projection;

#[path = "lists/semantic_context.rs"]
mod semantic_context;

#[path = "lists/ordered_tasks.rs"]
mod ordered_tasks;

#[path = "lists/fence_promotion.rs"]
mod fence_promotion;

#[path = "lists/common_actions.rs"]
mod common_actions;
