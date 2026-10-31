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
#[path = "lists/mixed_lifting.rs"]
mod mixed_lifting;
#[path = "lists/projection.rs"]
mod projection;

#[path = "lists/semantic_context.rs"]
mod semantic_context;

#[path = "lists/ordered_tasks.rs"]
mod ordered_tasks;

#[path = "lists/same_line_quotes.rs"]
mod same_line_quotes;

#[path = "lists/shared_prefix_frames.rs"]
mod shared_prefix_frames;

#[path = "lists/fence_promotion.rs"]
mod fence_promotion;
#[path = "lists/task_containers.rs"]
mod task_containers;
