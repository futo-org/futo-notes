//! The selection across a move, one rule for lines and photos: a selection
//! inside the moved text (exactly it, or part of it) travels with it; any
//! other selection keeps the text it covered and never takes in moved text
//! that lands at its edge. Literal display ranges, with neighbors whose
//! markers are hidden, since a hidden `# ` shares its display position with
//! the line start before it.
use super::super::{ok, range};
use super::images::image;
use super::line;
use crate::EditorSession;

/// (note, the selection, what is pressed: a line, or `None` for the first
/// photo, the boundary it lands on, the note after, the selection after).
type Case = (
    &'static str,
    (usize, usize),
    Option<usize>,
    usize,
    &'static str,
    (usize, usize),
);

fn check(cases: &[Case]) {
    for &(before, selected, pressed, to, after, landed) in cases {
        let mut session = EditorSession::open(before);
        let revision = session.revision();
        session
            .select(revision, range(selected.0, selected.1))
            .unwrap();
        let at = match pressed {
            Some(index) => line(&session, index),
            None => image(&session, 0).start,
        };
        session
            .move_block(revision, at, line(&session, to), &mut ok)
            .unwrap()
            .unwrap_or_else(|| panic!("{before:?} to {to} was refused"));
        assert_eq!(session.source_text(), after, "{before:?} to {to}");
        assert_eq!(
            session.selection(),
            range(landed.0, landed.1),
            "{before:?} {selected:?} to {to}"
        );
        session.undo(session.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(session.source_text(), before, "undo {before:?}");
        assert_eq!(
            session.selection(),
            range(selected.0, selected.1),
            "undo {before:?}"
        );
    }
}

#[test]
fn a_selection_of_exactly_the_moved_lines_travels_past_hidden_markers() {
    check(&[
        // The line below the block starts with a hidden marker.
        ("a\n# b\nc", (0, 2), Some(0), 3, "# b\nc\na", (4, 5)),
        ("a\n# b\nc", (0, 2), Some(0), 2, "# b\na\nc", (2, 4)),
        ("a\n- b\nc", (0, 2), Some(0), 3, "- b\nc\na", (4, 5)),
        ("a\n> b\nc", (0, 2), Some(0), 3, "> b\nc\na", (4, 5)),
        (
            "a\n```\nx\n```\nc",
            (0, 2),
            Some(0),
            5,
            "```\nx\n```\nc\na",
            (4, 5),
        ),
        // The moved line starts with one, and so does the line above it.
        ("x\n# a\nc", (2, 4), Some(1), 0, "# a\nx\nc", (0, 2)),
        ("# h\na\nc", (2, 4), Some(1), 0, "a\n# h\nc", (0, 2)),
        ("a\r\n# b\r\nc", (0, 3), Some(0), 3, "# b\r\nc\r\na", (6, 7)),
    ]);
}

#[test]
fn a_selection_beside_moved_lines_keeps_its_text() {
    check(&[
        // It ends where the block is inserted, or where it was removed.
        ("a\nb\nc", (0, 2), Some(2), 1, "a\nc\nb", (0, 2)),
        ("a\nb\nc\nd", (0, 2), Some(2), 1, "a\nc\nb\nd", (0, 2)),
        ("a\nb\nc", (0, 2), Some(1), 3, "a\nc\nb", (0, 2)),
        ("a\r\nb\r\nc", (0, 3), Some(1), 3, "a\r\nc\r\nb", (0, 3)),
        ("a\n# b\nc", (0, 2), Some(2), 1, "a\nc\n# b", (0, 2)),
        // It starts where the block is inserted, or where it was removed.
        ("a\nb\nc", (4, 5), Some(0), 2, "b\na\nc", (4, 5)),
        ("a\nb\nc", (4, 5), Some(1), 0, "b\na\nc", (4, 5)),
        // The note's last line, which has no line ending: the line that
        // becomes last gives its ending to the block.
        ("a\nb\nc", (2, 4), Some(2), 0, "c\na\nb", (4, 5)),
        ("a\nb\nc", (0, 2), Some(2), 0, "c\na\nb", (2, 4)),
        // Covering the block and more, it keeps the rest.
        ("a\nb\nc", (0, 4), Some(1), 3, "a\nc\nb", (0, 2)),
        ("a\nb\nc", (2, 5), Some(1), 0, "b\na\nc", (4, 5)),
    ]);
}

#[test]
fn a_selection_beside_a_moved_photo_keeps_its_text() {
    check(&[
        // It ends where the photo lands.
        (
            "a\nb\nx![](x.jpg)",
            (0, 2),
            None,
            1,
            "a\n![](x.jpg)\nb\nx",
            (0, 2),
        ),
        (
            "a\n# b![](x.jpg)",
            (0, 2),
            None,
            1,
            "a\n![](x.jpg)\n# b",
            (0, 2),
        ),
        (
            "a\r\nb\r\nx![](x.jpg)",
            (0, 3),
            None,
            1,
            "a\r\n![](x.jpg)\r\nb\r\nx",
            (0, 3),
        ),
        // It starts where the photo lands.
        (
            "a\nx![](x.jpg)\nc",
            (14, 15),
            None,
            2,
            "a\nx\n![](x.jpg)\nc",
            (15, 16),
        ),
        // Covering the photo and more, it keeps the rest.
        (
            "Nice!![](a.jpg)\nb",
            (0, 15),
            None,
            2,
            "Nice!\nb\n![](a.jpg)",
            (0, 5),
        ),
        (
            "![](a.jpg)text",
            (0, 14),
            None,
            1,
            "text\n![](a.jpg)",
            (0, 4),
        ),
        // It ends or starts where the photo was.
        (
            "Nice!![](a.jpg)",
            (0, 5),
            None,
            1,
            "Nice!\n![](a.jpg)",
            (0, 5),
        ),
        (
            "![](a.jpg)text",
            (10, 14),
            None,
            1,
            "text\n![](a.jpg)",
            (0, 4),
        ),
    ]);
}
