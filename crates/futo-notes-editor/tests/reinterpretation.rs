//! A source edit that opens a fence or removes its closer changes the meaning
//! of every later block. Each user-reachable path must leave the projection
//! equal to a fresh open of the same source (#313).
use futo_notes_editor::{
    DisplayOffset, DisplayRange, EditorSession, ParagraphKey, ProjectionSlice, Revision,
    SourceEdit, SourceOffset, SourceRange,
};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

fn whole(session: &EditorSession) -> ProjectionSlice {
    let end = session.display_text().len();
    session.project(session.revision(), range(0, end)).unwrap()
}

/// The projection, including its source correspondence, must equal a fresh
/// open; the literal source is the oracle.
fn assert_fresh(session: &EditorSession, expected: &str, name: &str) {
    assert_eq!(session.source_text(), expected, "{name}");
    let fresh = EditorSession::open(expected);
    assert_eq!(session.display_text(), fresh.display_text(), "{name}");
    let (got, mut want) = (whole(session), whole(&fresh));
    want.revision = got.revision;
    assert!(got == want, "{name}");
}

fn tail(paragraphs: usize) -> String {
    (0..paragraphs).map(|i| format!("para {i}\n\n")).collect()
}

fn ok(_: &SourceEdit) -> Result<(), String> {
    Ok(())
}

fn find(session: &EditorSession, needle: &str) -> usize {
    session.display_text().find(needle).unwrap()
}

fn replay(session: &mut EditorSession, at: usize, end: usize, inserted: &str) {
    let revision = session.revision();
    let source = session.source_text();
    session
        .replay(&SourceEdit {
            previous_revision: revision,
            revision: Revision(revision.0 + 1),
            range: SourceRange {
                start: SourceOffset(at),
                end: SourceOffset(end),
            },
            removed: source[at..end].to_owned(),
            inserted: inserted.to_owned(),
        })
        .unwrap();
}

/// Store recovery replays exact records; their reach is not planned input's.
#[test]
fn raw_replays_reinterpret_everything_they_reach() {
    let comment: String = (0..200).map(|i| format!("- line {i}\n")).collect();
    let comment = format!("<!-- open\n{comment}-->\n- after\n- more\n");
    let early = comment.find("line 150").unwrap();
    let cases = [
        // A fence opened above a long tail.
        (format!("intro\n\n{}", tail(40)), 7, 7, "```\n"),
        // A list continued by an item two blank rows later.
        ("para\n\n\n- b\n".to_owned(), 0, 0, "- "),
        // An empty item's blank leaves the list before a paragraph.
        ("\n\npara\n\nmore\n".to_owned(), 0, 0, "1. "),
        // A long comment ended early: the list after its old end joins the
        // list it now ends above.
        (comment, early, early, "-->"),
    ];
    for (source, at_source, end, inserted) in cases {
        let mut session = EditorSession::open(&source);
        replay(&mut session, at_source, end, inserted);
        let expected = format!("{}{inserted}{}", &source[..at_source], &source[end..]);
        assert_fresh(
            &session,
            &expected,
            &format!("{inserted:?} into {source:.20?}"),
        );
        // List ownership is not in the slice; Backspace at each line start
        // must act as it does in a fresh session.
        let display = session.display_text();
        let starts = std::iter::once(0).chain(display.match_indices('\n').map(|(i, _)| i + 1));
        for at in starts {
            let key = |mut session: EditorSession| {
                let caret = range(at, at);
                let revision = session.revision();
                let change =
                    session.paragraph_key(revision, caret, ParagraphKey::Backspace, &mut ok);
                change.map(|_| session.source_text())
            };
            let mut replayed = EditorSession::open(&source);
            replay(&mut replayed, at_source, end, inserted);
            assert_eq!(
                key(replayed),
                key(EditorSession::open(&expected)),
                "{inserted:?} at {at}"
            );
        }
    }
}

#[test]
fn pasting_over_a_closer_line_ending_reinterprets_the_tail_and_history() {
    let source = format!("```\ncode\n```\n\n{}", tail(40));
    let mut session = EditorSession::open(&source);
    // Display `code` then the closer's hidden line; the paste lands after the
    // closer's backticks and so turns the closer into code content.
    let at = find(&session, "code") + 4;
    session
        .paste_markdown(session.revision(), range(at, at + 1), "x", &mut ok)
        .unwrap();
    let opened = format!("```\ncode\n```x\n{}", tail(40));
    assert_fresh(&session, &opened, "paste");
    session.undo(session.revision(), &mut ok).unwrap();
    assert_fresh(&session, &source, "undo");
    session.redo(session.revision(), &mut ok).unwrap();
    assert_fresh(&session, &opened, "redo");
}
