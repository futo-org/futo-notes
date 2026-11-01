//! Input that changes how a note is cut into rows never panics and leaves a
//! projection equal to a fresh open (#283).
use crate::{DisplayOffset, DisplayRange, EditorSession, ProjectionSlice};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

fn whole(session: &EditorSession) -> ProjectionSlice {
    let end = session.display_text().len();
    let mut slice = session.project(session.revision(), range(0, end)).unwrap();
    slice.revision = crate::Revision(0);
    slice.correspondence.clear();
    slice.links.clear();
    slice
}

/// Widening a refused input to its blank-separated piece reads each row's
/// tail on a character boundary.
#[test]
fn widening_past_a_non_ascii_row_end_does_not_panic() {
    for (source, at, text) in [
        ("Done 🎉\n\n[ab](u) x\n", 11, "]("),
        ("Done 🎉\n\n[ab](u) x\n", 11, "[["),
        ("[a](b) 中文\n\nw\n", 1, "]("),
    ] {
        let mut session = EditorSession::open(source);
        let revision = session.revision();
        let _ = session.replace(revision, range(at, at), text, &mut |_| Ok(()));
        let fresh = EditorSession::open(&session.source_text());
        assert!(whole(&session) == whole(&fresh), "{source:?}");
    }
}

/// A cut fence row that gains `[[` still ends its fence where a fresh open does.
#[test]
fn wikilink_opener_typed_into_a_cut_fence_keeps_the_fence() {
    let body: String = (0..300).map(|i| format!("code {i}\n")).collect();
    for (line, (open, close)) in [0, 120, 240, 299]
        .into_iter()
        .flat_map(|line| [(line, ("```", "```")), (line, ("<pre>", "</pre>"))])
    {
        let source = format!("{open}\n{body}{close}\n- item 1\n");
        let mut session = EditorSession::open(&source);
        let at = session
            .display_text()
            .find(&format!("code {line}\n"))
            .unwrap();
        let revision = session.revision();
        session
            .replace(revision, range(at, at), "[[", &mut |_| Ok(()))
            .unwrap();
        let fresh = EditorSession::open(&session.source_text());
        assert!(whole(&session) == whole(&fresh), "{open} line {line}");
    }
}
