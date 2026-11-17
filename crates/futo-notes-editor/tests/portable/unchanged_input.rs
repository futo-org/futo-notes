//! Input that changes no source: nothing to send, no Undo step, the caret where
//! the same input that changed text would leave it, and the session still takes input.
use super::{at, utf16};
use futo_notes_editor::{
    Affinity, DisplayRange, DisplayReplacement, DisplayUtf16Replacement, ParagraphKey,
    PortableSession, Revision, SessionToken,
};

fn open_selected(source: &str, selection: DisplayRange) -> PortableSession {
    let mut session = PortableSession::open(SessionToken(1), source, Revision(0));
    session
        .select_with_affinity(Revision(0), selection, Affinity::Backward)
        .unwrap();
    session
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// Where typing `text` over `range` leaves the selection in a fresh session.
fn caret_after_typing(source: &str, range: DisplayRange, text: &str) -> DisplayRange {
    let mut session = open_selected(source, range);
    session.replace(Revision(0), range, text).unwrap();
    session.selection()
}

fn assert_unchanged(session: &mut PortableSession, source: &str, selection: DisplayRange) {
    assert_eq!(session.draft_text(), source);
    assert_eq!(session.status().local, Revision(0));
    assert_eq!(session.status().outstanding, 0);
    assert_eq!(session.selection(), selection);
    assert!(session.undo(Revision(0)).unwrap().is_none());
    let end = session.display_len();
    session.replace(Revision(0), at(end, end), "!").unwrap();
    assert_eq!(session.draft_text(), format!("{source}!"));
    assert_eq!(session.status().outstanding, 1);
}

#[test]
fn typing_the_selected_letter_again_changes_nothing_and_collapses_to_its_end() {
    let mut session = open_selected("ab", at(1, 2));
    let applied = session.replace(Revision(0), at(1, 2), "b").unwrap();
    assert!(applied.is_none());
    assert_eq!(caret_after_typing("ab", at(1, 2), "x"), at(2, 2));
    assert_unchanged(&mut session, "ab", at(2, 2));
}

#[test]
fn an_identical_isolated_replacement_changes_nothing() {
    let mut session = open_selected("a word here", at(2, 6));
    let applied = session
        .replace_action(
            Revision(0),
            at(2, 6),
            "word",
            futo_notes_editor::InputAction::Isolated,
        )
        .unwrap();
    assert!(applied.is_none());
    assert_unchanged(&mut session, "a word here", at(6, 6));
}

#[test]
fn identical_utf16_replacements_change_nothing() {
    let mut session = open_selected("ab", at(0, 2));
    let applied = session
        .replace_utf16(Revision(0), utf16(0, 2), &units("ab"))
        .unwrap();
    assert!(applied.is_none());
    assert_unchanged(&mut session, "ab", at(2, 2));

    let mut session = open_selected("ab", at(0, 1));
    let applied = session
        .replace_utf16_action(
            Revision(0),
            utf16(0, 1),
            &units("a"),
            futo_notes_editor::InputAction::Typing,
        )
        .unwrap();
    assert!(applied.is_none());
    assert_unchanged(&mut session, "ab", at(1, 1));
}

#[test]
fn identical_replacements_of_several_runs_change_nothing_and_end_after_the_last() {
    let runs = [
        DisplayReplacement {
            range: at(0, 2),
            inserted: "ab".into(),
        },
        DisplayReplacement {
            range: at(3, 5),
            inserted: "cd".into(),
        },
    ];
    let mut session = open_selected("ab cd", at(0, 0));
    let applied = session.replace_many(Revision(0), &runs).unwrap();
    assert!(applied.is_none());
    assert_unchanged(&mut session, "ab cd", at(5, 5));

    let runs16 = runs.map(|run| DisplayUtf16Replacement {
        range: utf16(run.range.start.0, run.range.end.0),
        inserted: units(&run.inserted),
    });
    let mut session = open_selected("ab cd", at(0, 0));
    let applied = session.replace_many_utf16(Revision(0), &runs16).unwrap();
    assert!(applied.is_none());
    assert_unchanged(&mut session, "ab cd", at(5, 5));
}

#[test]
fn an_identical_text_service_replacement_changes_nothing() {
    let mut session = open_selected("ab", at(0, 2));
    let applied = session
        .replace_os_utf16(Revision(0), utf16(0, 2), &units("ab"), &[])
        .unwrap();
    assert!(applied.is_none());
    assert_unchanged(&mut session, "ab", at(2, 2));
}

#[test]
fn nothing_typed_over_nothing_keeps_the_selection() {
    let mut session = open_selected("ab", at(1, 2));
    let applied = session.replace(Revision(0), at(0, 0), "").unwrap();
    assert!(applied.is_none());
    assert_unchanged(&mut session, "ab", at(1, 2));
}

#[test]
fn a_key_that_only_moves_the_selection_sends_nothing() {
    let source = "| a | b |\n| - | - |\n| c | d |";
    let mut session = PortableSession::open(SessionToken(1), source, Revision(0));
    let display = session
        .project(Revision(0), at(0, session.display_len()))
        .unwrap()
        .text;
    let a = display.find('a').unwrap();
    let b = display.find('b').unwrap();
    session
        .select_with_affinity(Revision(0), at(a, a + 1), Affinity::Backward)
        .unwrap();
    let applied = session
        .paragraph_key_utf16(Revision(0), utf16(a, a + 1), ParagraphKey::Tab)
        .unwrap();
    assert!(applied.is_none());
    assert_eq!(session.selection(), at(b, b + 1));
    assert_eq!(session.status().local, Revision(0));
    assert_eq!(session.status().outstanding, 0);
}

#[test]
fn a_paired_backtick_at_a_code_span_end_sends_nothing_and_the_next_text_lands_outside() {
    use futo_notes_editor::InputAction;
    let mut session = open_selected("foo ", at(4, 4));
    let paired = session
        .replace_action(Revision(0), at(4, 4), "`", InputAction::PairedTyping)
        .unwrap();
    assert!(paired.is_some());
    assert_eq!(session.draft_text(), "foo ``");
    assert_eq!(session.selection(), at(5, 5));
    session.replace(Revision(1), at(5, 5), "bar").unwrap();
    let stepped = session
        .replace_action(Revision(2), at(7, 7), "`", InputAction::PairedTyping)
        .unwrap();
    assert!(stepped.is_none());
    assert_eq!(session.status().local, Revision(2));
    assert_eq!(session.selection(), at(7, 7));
    session.replace(Revision(2), at(7, 7), " baz").unwrap();
    assert_eq!(session.draft_text(), "foo `bar` baz");
}
