mod common;
use common::ReferenceView;
use futo_notes_editor::*;

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn japanese_marked_replacement_is_provisional_until_changed_commit() {
    let mut session = EditorSession::open("**日本**語\r\n");
    let mut view = ReferenceView::new("日本語\r\n");
    let marked = session.compose(Revision(0), range(0, 6), "にほん").unwrap();
    assert_eq!(marked.range, range(0, 6));
    assert_eq!(marked.text, "にほん");
    session.compose(Revision(0), range(0, 6), "日本").unwrap();
    assert_eq!(session.source_text(), "**日本**語\r\n");
    assert_eq!(session.revision(), Revision(0));
    let change = session
        .commit_composition(Revision(0), Some("日本国"), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    view.apply(change);
    assert_eq!(view.text, "日本国語\r\n");
    assert_eq!(session.source_text(), "**日本国**語\r\n");
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "**日本**語\r\n");
    assert_eq!(view.text, "日本語\r\n");
}

#[test]
fn whole_field_correction_keeps_unchanged_marker_and_entity_spelling() {
    let mut session = EditorSession::open("teh __middle__ &amp; wrng\r\n");
    let mut view = ReferenceView::new("teh middle & wrng\r\n");
    let change = session
        .replace_os(
            Revision(0),
            range(0, view.text.len()),
            "the middle & wrong\r\n",
            &[],
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
    view.apply(change);
    assert_eq!(view.text, "the middle & wrong\r\n");
    assert_eq!(session.source_text(), "the __middle__ &amp; wrong\r\n");
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "teh __middle__ &amp; wrng\r\n");
}

#[test]
fn empty_repeated_and_cancelled_composition_never_create_phantom_history() {
    let mut session = EditorSession::open("__word__\r\n");
    assert!(session
        .commit_composition(Revision(0), None, &mut |_| panic!("no append"))
        .unwrap()
        .is_none());
    session.compose(Revision(0), range(4, 4), "").unwrap();
    assert!(session
        .commit_composition(Revision(0), None, &mut |_| panic!("no append"))
        .unwrap()
        .is_none());
    session.compose(Revision(0), range(0, 4), "word").unwrap();
    assert!(session
        .commit_composition(Revision(0), None, &mut |_| panic!("no append"))
        .unwrap()
        .is_none());
    session
        .compose(Revision(0), range(0, 4), "discard")
        .unwrap();
    session.cancel_composition(Revision(0)).unwrap();
    session.cancel_composition(Revision(0)).unwrap();
    assert_eq!(session.source_text(), "__word__\r\n");
    assert!(session
        .undo(Revision(0), &mut |_| panic!("no history"))
        .unwrap()
        .is_none());
}

#[test]
fn formatting_commits_marked_text_first_while_undo_keeps_it_provisional() {
    let mut session = EditorSession::open("ab cd");
    let mut view = ReferenceView::new("ab cd");
    session.select(Revision(0), range(2, 2)).unwrap();
    session.compose(Revision(0), range(2, 2), "か").unwrap();
    assert!(session
        .undo(Revision(0), &mut |_| panic!("undo during composition"))
        .unwrap()
        .is_none());
    assert!(session.composition().is_some());
    view.apply(
        session
            .toggle_format(Revision(0), InlineFormat::Bold, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "abか cd");
    assert!(session.composition().is_none());
    assert_eq!(session.active_formats(), [InlineFormat::Bold]);
    view.apply(
        session
            .replace(session.revision(), range(5, 5), "z", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "abかz cd");
    assert_eq!(session.source_text(), "abか**z** cd");
}

#[test]
fn korean_replacement_last_and_platform_placeholders_keep_exact_literal_content() {
    let mut session = EditorSession::open("__한__ \u{fffc}\r\n");
    let mut view = ReferenceView::new("한 \u{fffc}\r\n");
    for text in ["하", "한", "하나"] {
        let change = session
            .replace_os(session.revision(), range(0, 3), text, &[], &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        view.apply(change);
    }
    assert_eq!(session.source_text(), "__하나__ \u{fffc}\r\n");
    let change = session
        .replace_os(
            session.revision(),
            range(6, 6),
            "\u{fffc}말",
            &[range(0, 3)],
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
    view.apply(change);
    assert_eq!(view.text, "하나말 \u{fffc}\r\n");
    assert_eq!(session.source_text(), "__하나말__ \u{fffc}\r\n");
}

#[test]
fn input_arriving_in_provisional_coordinates_commits_once_before_following_text() {
    let mut session = EditorSession::open("**b** x");
    let mut view = ReferenceView::new("b x");
    session.select(Revision(0), range(1, 1)).unwrap();
    session.compose(Revision(0), range(1, 1), "か").unwrap();
    let mut records = Vec::new();
    let change = session
        .replace(Revision(0), range(4, 4), "z", &mut |edit| {
            records.push(edit.clone());
            Ok(())
        })
        .unwrap();
    view.apply(change);
    assert_eq!(view.text, "bかz x");
    assert_eq!(session.source_text(), "**bかz** x");
    assert_eq!(records.len(), 1);
    assert!(session.composition().is_none());
}

#[test]
fn invalid_foreign_composition_and_failed_commit_retain_pending_text_and_history() {
    let mut session = EditorSession::open("**😀** x");
    let r = |a, b| DisplayUtf16Range {
        start: DisplayUtf16Offset(a),
        end: DisplayUtf16Offset(b),
    };
    session
        .compose_utf16(Revision(0), r(2, 2), &[0x304b])
        .unwrap();
    assert_eq!(
        session.compose_utf16(Revision(0), r(2, 2), &[0xd800]),
        Err(EditorError::InvalidText)
    );
    assert_eq!(
        session.commit_composition(Revision(1), None, &mut |_| panic!("stale")),
        Err(EditorError::StaleRevision {
            expected: Revision(1),
            actual: Revision(0)
        })
    );
    assert_eq!(
        session.commit_composition(Revision(0), Some("か!"), &mut |_| Err("disk full".into())),
        Err(EditorError::Persistence("disk full".into()))
    );
    assert_eq!(session.composition().unwrap().text, "か");
    assert_eq!(session.source_text(), "**😀** x");
    assert_eq!(session.revision(), Revision(0));
    session
        .commit_composition(Revision(0), None, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), "**😀か** x");
}

#[test]
fn unchanged_reconversion_finishes_at_marked_end_before_formatting_command() {
    let mut session = EditorSession::open("__word__ tail");
    let mut view = ReferenceView::new("word tail");
    session.select(Revision(0), range(0, 4)).unwrap();
    session.compose(Revision(0), range(0, 4), "word").unwrap();
    assert!(session
        .toggle_format(Revision(0), InlineFormat::Italic, &mut |_| panic!(
            "no source change"
        ))
        .unwrap()
        .is_none());
    assert_eq!(session.selection(), range(4, 4));
    view.apply(
        session
            .replace(Revision(0), range(4, 4), "x", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "wordx tail");
    assert_eq!(session.source_text(), "__word*x*__ tail");
}

#[test]
fn compound_command_during_composition_uses_provisional_ranges_in_one_acceptance() {
    let mut session = EditorSession::open("__a__ tail");
    let mut view = ReferenceView::new("a tail");
    session.compose(Revision(0), range(1, 1), "日").unwrap();
    let mut records = Vec::new();
    let change = session
        .replace_many(
            Revision(0),
            &[
                DisplayReplacement {
                    range: range(0, 1),
                    inserted: "A".into(),
                },
                DisplayReplacement {
                    range: range(5, 9),
                    inserted: "end".into(),
                },
            ],
            &mut |edit| {
                records.push(edit.clone());
                Ok(())
            },
        )
        .unwrap();
    view.apply(change);
    assert_eq!(records.len(), 1);
    assert_eq!(view.text, "A日 end");
    assert_eq!(session.source_text(), "__A日__ end");
    assert!(session.composition().is_none());
}
