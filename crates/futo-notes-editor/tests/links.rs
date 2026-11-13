use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession, Revision};
mod common;
use common::ReferenceView;

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[path = "links/commands.rs"]
mod commands;
#[path = "links/labels.rs"]
mod labels;
#[path = "links/os_input.rs"]
mod os_input;
#[path = "links/pending_metadata.rs"]
mod pending_metadata;
#[path = "links/projection.rs"]
mod projection;
#[path = "links/word_end.rs"]
mod word_end;

#[path = "links/tables.rs"]
mod tables;
