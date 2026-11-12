//! Front matter exists only once a `---` line closes line 1's `---`, so
//! typing or deleting that closing line restyles the lines above it. After
//! each edit the session must read exactly as a fresh open of its source.
use futo_notes_editor::*;

fn whole(session: &EditorSession) -> ProjectionSlice {
    let end = DisplayOffset(session.display_text().len());
    let mut slice = session
        .project(
            session.revision(),
            DisplayRange {
                start: DisplayOffset(0),
                end,
            },
        )
        .unwrap();
    slice.revision = Revision(0);
    slice
}

fn assert_fresh(session: &EditorSession) {
    let fresh = EditorSession::open(&session.source_text());
    assert_eq!(session.display_text(), fresh.display_text());
    assert_eq!(whole(session), whole(&fresh));
}

/// Type `text` at the display end of `session`'s line `line` (0-based).
fn type_at_line_end(session: &mut EditorSession, line: usize, text: &str) {
    let display = session.display_text();
    let mut at = 0;
    for (index, part) in display.split('\n').enumerate() {
        if index == line {
            at += part.len();
            break;
        }
        at += part.len() + 1;
    }
    let range = DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    };
    session
        .replace(session.revision(), range, text, &mut |_| Ok(()))
        .unwrap();
}

#[test]
fn typing_the_closing_line_opens_front_matter_and_breaking_it_closes_it() {
    let mut session = EditorSession::open("---\ntitle: x\n--\n# body");
    assert_eq!(session.display_text(), "\u{fffc}\ntitle: x\n--\nbody");
    // `--` becomes `---`: line 1 now opens front matter.
    type_at_line_end(&mut session, 2, "-");
    assert_eq!(session.source_text(), "---\ntitle: x\n---\n# body");
    assert_fresh(&session);
    assert_eq!(session.display_text(), "title: x\nbody");
    // Undo restores the divider reading and the exact bytes.
    session.undo(session.revision(), &mut |_| Ok(())).unwrap();
    assert_eq!(session.source_text(), "---\ntitle: x\n--\n# body");
    assert_fresh(&session);
}

#[test]
fn removing_the_closing_line_turns_line_one_back_into_a_divider() {
    let source = "---\ntitle: x\n---\nbody";
    let mut session = EditorSession::open(source);
    assert_eq!(session.display_text(), "title: x\nbody");
    let start = source.find("\n---\n").unwrap();
    let edit_end = start + 4;
    // Delete the closing `---` line through the source, as an outside writer would.
    let edited = format!("{}{}", &source[..start], &source[edit_end..]);
    let mut session = EditorSession::open(&edited);
    assert_eq!(session.display_text(), "\u{fffc}\ntitle: x\nbody");
    assert_fresh(&session);
    type_at_line_end(&mut session, 1, "\n---");
    assert_eq!(session.source_text(), source);
    assert_fresh(&session);
}
