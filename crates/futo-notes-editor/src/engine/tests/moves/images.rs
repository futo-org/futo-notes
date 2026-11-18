//! A photo that shares its line with other content lifts alone, lands as a
//! line of its own, and leaves the rest of its line as written.
use super::super::properties::checks::check_fresh;
use super::super::{ok, range};
use super::{line, lines};
use crate::{DisplayOffset, EditorError, EditorSession, Revision};

/// The display range of image `n` (0 the first) in `session`'s display, which
/// shows each image's whole spelling: what is under a finger on it.
pub(super) fn image(session: &EditorSession, n: usize) -> crate::DisplayRange {
    let text = session.display_text();
    let start = text
        .match_indices("![](")
        .nth(n)
        .expect("the image shows")
        .0;
    let end = start + text[start..].find(')').expect("its end") + 1;
    crate::DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn an_image_sharing_its_line_lifts_alone_and_nothing_else_does() {
    // (note, the image under the finger, whether it lifts alone; else the
    // lines that lift instead).
    for (note, under, alone, lines_lifted) in [
        ("Nice!![](a.jpg)", 0, true, 0..0),
        ("# Title![](a.jpg)", 0, true, 0..0),
        ("- item![](a.jpg)\n  - child", 0, true, 0..0),
        ("![](a.jpg)![](b.jpg)", 1, true, 0..0),
        // Alone on its line, markers and whitespace aside: the line lifts.
        ("![](a.jpg)", 0, false, 0..1),
        ("![](a.jpg)  \nb", 0, false, 0..1),
        ("- ![](a.jpg)\n  - child", 0, false, 0..2),
        // Inside a quote run or a table the unit lifts, as before.
        ("> Nice!![](a.jpg)\n> b", 0, false, 0..2),
        ("| a![](x.jpg) |\n|---|\n| 1 |", 0, false, 0..3),
        // Inside another mark, taking it out would leave that mark empty.
        ("**![](a.jpg)** x", 0, false, 0..1),
        ("[![](a.jpg)](u) x", 0, false, 0..1),
    ] {
        let session = EditorSession::open(note);
        let at = image(&session, under);
        let want = if alone {
            at
        } else {
            lines(&session, lines_lifted)
        };
        assert_eq!(
            session.block_at(Revision(0), at.start).unwrap(),
            Some(want),
            "{note:?}"
        );
    }
    // Anywhere off the image, its line lifts whole, the photo with it: the
    // line's start, its text, its end.
    let session = EditorSession::open("Nice!![](a.jpg)\nb");
    for at in [0, 3, 15] {
        assert_eq!(
            session.block_at(Revision(0), DisplayOffset(at)).unwrap(),
            Some(lines(&session, 0..1)),
            "at {at}"
        );
    }
    let session = EditorSession::open("![](a.jpg)text");
    assert_eq!(
        session.block_at(Revision(0), DisplayOffset(10)).unwrap(),
        Some(lines(&session, 0..1))
    );
}

#[test]
fn a_lifted_image_lands_where_a_plain_line_would_and_beside_its_own_line() {
    // (note, the image, the boundaries it may land on; line 1 is its line.)
    for (note, under, slots) in [
        ("a\nNice!![](x.jpg)\nb", 0, &[0, 1, 2, 3][..]),
        // Inside a list, as a plain line may.
        ("- a\n- item![](x.jpg)\n- b", 0, &[0, 1, 2, 3]),
        // Not inside a quote run, beside it.
        ("> q\n> r\nNice!![](x.jpg)", 0, &[0, 2, 3]),
        // After a final line ending, the boundary above the empty last line
        // is its line's bottom edge, and still a slot.
        ("a\nNice!![](x.jpg)\n", 0, &[0, 1, 2]),
    ] {
        let session = EditorSession::open(note);
        let at = image(&session, under).start;
        let want: Vec<_> = slots.iter().map(|&b| line(&session, b)).collect();
        assert_eq!(
            session.block_slots(Revision(0), at).unwrap(),
            want,
            "{note:?}"
        );
    }
}

#[test]
fn a_lifted_image_leaves_its_line_as_written_and_lands_as_a_line_of_its_own() {
    // (note, the image, the boundary it lands on, the note after).
    for (before, under, to, after) in [
        // Directly below or above its line separates the two.
        ("Nice!![](a.jpg)", 0, 1, "Nice!\n![](a.jpg)"),
        ("Nice!![](a.jpg)", 0, 0, "![](a.jpg)\nNice!"),
        ("Nice!![](a.jpg)\n", 0, 1, "Nice!\n![](a.jpg)\n"),
        // Far away.
        ("Nice!![](a.jpg)\nb\nc", 0, 2, "Nice!\nb\n![](a.jpg)\nc"),
        ("Nice!![](a.jpg)\nb\nc", 0, 3, "Nice!\nb\nc\n![](a.jpg)"),
        ("a\nb\nNice!![](x.jpg)", 0, 0, "![](x.jpg)\na\nb\nNice!"),
        // First on its line, between text (its spaces stay), two on a line.
        ("![](a.jpg)text", 0, 1, "text\n![](a.jpg)"),
        ("![](a.jpg)text", 0, 0, "![](a.jpg)\ntext"),
        ("a ![](x.jpg) b", 0, 1, "a  b\n![](x.jpg)"),
        ("a ![](x.jpg) b", 0, 0, "![](x.jpg)\na  b"),
        ("![](a.jpg)![](b.jpg)", 0, 1, "![](b.jpg)\n![](a.jpg)"),
        ("![](a.jpg)![](b.jpg)", 1, 1, "![](a.jpg)\n![](b.jpg)"),
        ("![](a.jpg)![](b.jpg)", 1, 0, "![](b.jpg)\n![](a.jpg)"),
        // Out of a list item, between items, as written.
        ("- item![](a.jpg)\n- two", 0, 1, "- item\n![](a.jpg)\n- two"),
        ("# T![](a.jpg)\nb", 0, 2, "# T\nb\n![](a.jpg)"),
        // The note's last line: the image takes a line ending of the note's
        // up, and gives one to the line that was last down.
        ("a\nNice!![](x.jpg)", 0, 0, "![](x.jpg)\na\nNice!"),
        ("Nice!![](x.jpg)\na", 0, 2, "Nice!\na\n![](x.jpg)"),
        ("Nice!![](a.jpg)\r\nb", 0, 1, "Nice!\r\n![](a.jpg)\r\nb"),
        ("Nice!![](a.jpg)\r\nb", 0, 2, "Nice!\r\nb\r\n![](a.jpg)"),
        ("a\r\nNice!![](x.jpg)", 0, 0, "![](x.jpg)\r\na\r\nNice!"),
        // In a quote run or a table, the unit moves as before.
        (
            "p\n> Nice!![](a.jpg)\n> b",
            0,
            0,
            "> Nice!![](a.jpg)\n> b\np",
        ),
        (
            "| a![](x.jpg) |\n|---|\n| 1 |\nq",
            0,
            4,
            "q\n| a![](x.jpg) |\n|---|\n| 1 |",
        ),
    ] {
        let mut session = EditorSession::open(before);
        let revision = session.revision();
        let at = image(&session, under).start;
        let to = line(&session, to);
        assert!(
            session.block_slots(revision, at).unwrap().contains(&to),
            "{before:?}"
        );
        let change = session
            .move_block(revision, at, to, &mut ok)
            .unwrap()
            .unwrap_or_else(|| panic!("{before:?} image {under} was refused"));
        assert_eq!(session.source_text(), after, "{before:?} image {under}");
        assert_eq!(change.revision, Revision(revision.0 + 1));
        check_fresh(session.engine(), &format!("moved {before:?}"));
        session.undo(session.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(session.source_text(), before, "undo {before:?}");
        assert!(!session.toolbar_state().can_undo, "one step {before:?}");
    }
}

#[test]
fn a_selected_image_travels_with_it_and_a_caret_stays_with_its_text() {
    // (note, the selection, the boundary, the note after, the selection after).
    for (before, selected, to, after, landed) in [
        ("Nice!![](a.jpg)", (5, 15), 1, "Nice!\n![](a.jpg)", (6, 16)),
        (
            "Nice!![](a.jpg)\nb",
            (5, 15),
            0,
            "![](a.jpg)\nNice!\nb",
            (0, 10),
        ),
        // A caret after the image (where a tap puts it) stays after `Nice!`.
        (
            "Nice!![](a.jpg)\nb",
            (15, 15),
            2,
            "Nice!\nb\n![](a.jpg)",
            (5, 5),
        ),
        (
            "Nice!![](a.jpg)\nb",
            (2, 2),
            0,
            "![](a.jpg)\nNice!\nb",
            (13, 13),
        ),
    ] {
        let mut session = EditorSession::open(before);
        let revision = session.revision();
        session
            .select(revision, range(selected.0, selected.1))
            .unwrap();
        let at = image(&session, 0).start;
        session
            .move_block(revision, at, line(&session, to), &mut ok)
            .unwrap()
            .unwrap_or_else(|| panic!("{before:?} was refused"));
        assert_eq!(session.source_text(), after, "{before:?}");
        assert_eq!(session.selection(), range(landed.0, landed.1), "{before:?}");
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
fn an_image_move_that_would_change_its_line_or_is_stale_changes_nothing() {
    // Without the image, `---` is a divider, and ` text` an indented line.
    for note in ["x\n---![](a.jpg)", "x\n![](a.jpg) text"] {
        let mut session = EditorSession::open(note);
        let revision = session.revision();
        let at = image(&session, 0).start;
        let to = line(&session, 0);
        assert!(session.block_slots(revision, at).unwrap().contains(&to));
        assert_eq!(
            session.move_block(revision, at, to, &mut ok).unwrap(),
            None,
            "{note:?}"
        );
        assert_eq!(session.source_text(), note);
        assert!(!session.toolbar_state().can_undo, "{note:?}");
    }
    let mut session = EditorSession::open("Nice!![](a.jpg)");
    session
        .replace(Revision(0), range(0, 0), "x", &mut ok)
        .unwrap();
    assert_eq!(
        session.move_block(Revision(0), DisplayOffset(6), DisplayOffset(0), &mut ok),
        Err(EditorError::StaleRevision {
            expected: Revision(0),
            actual: Revision(1)
        })
    );
    assert_eq!(session.source_text(), "xNice!![](a.jpg)");
}
