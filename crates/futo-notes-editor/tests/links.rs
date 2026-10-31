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
#[path = "links/os_input.rs"]
mod os_input;
#[path = "links/pending_metadata.rs"]
mod pending_metadata;
#[path = "links/projection.rs"]
mod projection;
#[path = "links/reference_staging.rs"]
mod reference_staging;
#[path = "links/references.rs"]
mod references;
#[path = "links/word_end.rs"]
mod word_end;

#[path = "links/reference_blocks.rs"]
mod reference_blocks;

#[path = "links/derived_pending.rs"]
mod derived_pending;

#[path = "links/angle_pending.rs"]
mod angle_pending;

#[path = "links/angle_authored.rs"]
mod angle_authored;

#[path = "links/partial_url_commands.rs"]
mod partial_url_commands;

#[path = "links/physical_prefixes.rs"]
mod physical_prefixes;

#[path = "links/code_literal_edits.rs"]
mod code_literal_edits;
