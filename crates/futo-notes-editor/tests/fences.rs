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
#[path = "fences/code_off.rs"]
mod code_off;
#[path = "fences/frame.rs"]
mod frame;
#[path = "fences/input.rs"]
mod input;
#[path = "fences/keys.rs"]
mod keys;
#[path = "fences/projection.rs"]
mod projection;
#[path = "fences/protected_input.rs"]
mod protected_input;

#[path = "fences/physical_rows.rs"]
mod physical_rows;

fn assert_fresh_projection(session: &EditorSession, shown: &str) {
    assert_eq!(session.display_text(), shown);
    let mut actual = session
        .project(session.revision(), range(0, shown.len()))
        .unwrap();
    let fresh = EditorSession::open(&session.source_text());
    let expected = fresh
        .project(fresh.revision(), range(0, shown.len()))
        .unwrap();
    actual.revision = expected.revision;
    assert_eq!(actual, expected);
}
