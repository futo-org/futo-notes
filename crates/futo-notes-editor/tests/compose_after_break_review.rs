//! #413 review findings: CRLF in a table cell, commits before a rule at the note start,
//! OS inserts after a rule, and a key during composition after a rule.
use futo_notes_editor::*;

fn at(a: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(a),
    }
}
fn open_at(src: &str, caret: usize) -> EditorSession {
    let mut s = EditorSession::open(src);
    s.select(s.revision(), at(caret)).unwrap();
    s
}
fn commit(
    s: &mut EditorSession,
    marked: &str,
    text: &str,
) -> Result<Option<ViewChange>, EditorError> {
    let sel = s.selection();
    s.compose(s.revision(), sel, marked)?;
    s.commit_composition(s.revision(), Some(text), &mut |_| Ok(()))
}

/// F1 (regression): a CRLF multi-line OS insert / composition commit in a table
/// cell is flattened to "x y"; main accepts it, the branch refuses it.
#[test]
fn f1_cell_crlf_os_insert_is_accepted() {
    let src = "| a | b |\n| - | - |\n| c | d |";
    let mut s = open_at(src, 23);
    let res = s.replace_os(s.revision(), at(23), "x\r\ny", &[], &mut |_| Ok(()));
    assert!(res.is_ok(), "replace_os refused: {res:?}");
    assert_eq!(s.source_text(), "| a | b |\n| - | - |\n| cx y | d |");
    assert_eq!(s.selection(), at(26));
    let mut s = open_at(src, 23);
    let res = commit(&mut s, "x", "x\r\ny");
    assert!(res.is_ok(), "commit refused: {res:?}");
    assert_eq!(s.source_text(), "| a | b |\n| - | - |\n| cx y | d |");
}

/// F2 (incomplete fix, same on main): a commit or OS insert right before a rule
/// on the note's first line is refused, though typing lands as "é\n***".
#[test]
fn f2_commit_before_rule_at_note_start_lands_like_typing() {
    for src in ["---", "***", "- - -"] {
        let mut s = open_at(src, 0);
        let res = commit(&mut s, "´", "é");
        assert!(matches!(res, Ok(Some(_))), "{src:?}: commit {res:?}");
        assert_eq!(
            (s.display_text(), s.selection()),
            ("é\n\u{FFFC}".to_string(), at(2)),
            "{src:?}"
        );
    }
}

/// F3 (fixed by the branch, red on main): the caret after an OS insert / QuickType
/// pick right after a rule sits after the inserted text.
#[test]
fn f3_os_insert_after_rule_caret() {
    for src in ["---", "> ---", "a\n\n***", "# H\n***"] {
        let end = EditorSession::open(src).display_text().len();
        let mut s = open_at(src, end);
        s.replace_os(s.revision(), at(end), "Hello", &[], &mut |_| Ok(()))
            .unwrap();
        assert_eq!(
            s.selection(),
            at(s.display_text().len()),
            "{src:?} -> {:?}",
            s.display_text()
        );
        // QuickType replacing marked text right after the rule
        let mut s = open_at(src, end);
        s.compose(s.revision(), at(end), "e").unwrap();
        let res = s.replace_os(
            s.revision(),
            DisplayRange {
                start: DisplayOffset(end),
                end: DisplayOffset(end + 1),
            },
            "é",
            &[],
            &mut |_| Ok(()),
        );
        assert!(matches!(res, Ok(Some(_))), "{src:?}: quicktype {res:?}");
        assert!(
            s.display_text().ends_with("\u{FFFC}\né"),
            "{src:?} -> {:?}",
            s.display_text()
        );
        assert_eq!(s.selection(), at(s.display_text().len()), "{src:?}");
    }
}

/// F4 (fixed by the branch, wrong on main): a key typed while text is marked right
/// after a rule lands after the marked text (main typed it before: " e").
#[test]
fn f4_key_during_composition_after_rule() {
    let mut s = open_at("a\n\n---", 6);
    s.compose(s.revision(), at(6), "e").unwrap();
    s.replace(s.revision(), at(7), " ", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "a\n\n---\ne ");
    assert_eq!(s.selection(), at(9));
}
