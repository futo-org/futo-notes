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

#[test]
fn paragraph_keys_use_the_provisional_display_and_commit_one_protected_action() {
    for (key, source, display, caret) in [
        (ParagraphKey::Enter, "**bか**\n x", "bか\n x", 5),
        (ParagraphKey::Backspace, "**b** x", "b x", 1),
        (ParagraphKey::Delete, "**bか**x", "bかx", 4),
    ] {
        let mut session = EditorSession::open("**b** x");
        let mut view = ReferenceView::new("b x");
        session.select(Revision(0), range(1, 1)).unwrap();
        session.compose(Revision(0), range(1, 1), "か").unwrap();
        let mut records = Vec::new();
        let result = session
            .paragraph_key(Revision(0), range(4, 4), key, &mut |edit| {
                records.push(edit.clone());
                Ok(())
            })
            .unwrap();
        if let Some(change) = result {
            view.apply(change);
        }
        assert_eq!(view.text, display, "{key:?}");
        assert_eq!(session.source_text(), source, "{key:?}");
        assert_eq!(session.selection(), range(caret, caret));
        assert_eq!(
            records.len(),
            if key == ParagraphKey::Backspace { 0 } else { 1 }
        );
        assert!(session.composition().is_none());
    }
}

#[test]
fn failed_paragraph_commit_keeps_the_entire_marked_draft_for_retry() {
    let mut session = EditorSession::open("__a__ tail\r\n");
    session.select(Revision(0), range(1, 1)).unwrap();
    session.compose(Revision(0), range(1, 1), "👩‍💻").unwrap();
    let range16 = DisplayUtf16Range {
        start: DisplayUtf16Offset(6),
        end: DisplayUtf16Offset(6),
    };
    let mut count = 0;
    assert_eq!(
        session.paragraph_key_utf16(Revision(0), range16, ParagraphKey::Enter, &mut |_| {
            count += 1;
            Err("disk full".into())
        }),
        Err(EditorError::Persistence("disk full".into()))
    );
    assert_eq!(count, 1);
    assert_eq!(session.source_text(), "__a__ tail\r\n");
    assert_eq!(session.revision(), Revision(0));
    assert_eq!(session.composition().unwrap().text, "👩‍💻");
    assert!(session
        .paragraph_key_utf16(
            Revision(0),
            range16,
            ParagraphKey::Backspace,
            &mut |_| panic!("only pending grapheme removed")
        )
        .unwrap()
        .is_none());
    assert!(session.composition().is_none());
    assert_eq!(session.selection(), range(1, 1));
}

#[test]
fn marked_replacement_crosses_format_boundary_and_keeps_exact_undo() {
    let mut session = EditorSession::open("**ab**cd\r\n");
    let mut view = ReferenceView::new("abcd\r\n");
    session.compose(Revision(0), range(1, 3), "日本").unwrap();
    view.apply(
        session
            .commit_composition(Revision(0), None, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "**a日本**d\r\n");
    assert_eq!(view.text, "a日本d\r\n");
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "**ab**cd\r\n");
    assert_eq!(view.text, "abcd\r\n");
}

#[test]
fn pending_commit_is_isolated_from_following_typing_but_following_letters_group() {
    let mut session = EditorSession::open("**b** x");
    let mut view = ReferenceView::new("b x");
    session.select(Revision(0), range(1, 1)).unwrap();
    session.compose(Revision(0), range(1, 1), "か").unwrap();
    view.apply(
        session
            .replace(Revision(0), range(4, 4), "z", &mut |_| Ok(()))
            .unwrap(),
    );
    view.apply(
        session
            .replace(Revision(1), range(5, 5), "q", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "bかzq x");
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(view.text, "bか x");
    assert_eq!(session.source_text(), "**bか** x");
    view.apply(session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "**b** x");
    view.apply(session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(session.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "**bかzq** x");
}

#[test]
fn replay_cannot_shift_a_pending_composition_before_host_acceptance() {
    let mut session = EditorSession::open("ab");
    session.compose(Revision(0), range(1, 1), "日").unwrap();
    let record = SourceEdit {
        previous_revision: Revision(0),
        revision: Revision(1),
        range: SourceRange {
            start: SourceOffset(0),
            end: SourceOffset(0),
        },
        removed: "".into(),
        inserted: "prefix ".into(),
    };
    assert_eq!(
        session.replay_with_accept(&record, &mut |_| panic!(
            "replay must not accept over marked state"
        )),
        Err(EditorError::CompositionActive)
    );
    assert_eq!(session.source_text(), "ab");
    assert_eq!(session.composition().unwrap().range, range(1, 1));
}

#[test]
fn legacy_host_owned_commit_cannot_mix_with_engine_owned_composition() {
    let mut session = EditorSession::open("__word__");
    session.compose(Revision(0), range(0, 4), "か").unwrap();
    assert_eq!(
        session.replace_action(
            Revision(0),
            range(0, 3),
            "語",
            InputAction::CompositionCommit,
            &mut |_| panic!("mixed composition ownership must reject before acceptance")
        ),
        Err(EditorError::CompositionActive)
    );
    assert_eq!(session.source_text(), "__word__");
    assert_eq!(session.composition().unwrap().text, "か");
    session
        .commit_composition(Revision(0), Some("語"), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), "__word__");
}

/// Each marked character's reported formats, by byte offset into the marked text.
fn marked_formats(marked: &Composition) -> Vec<Vec<InlineFormat>> {
    marked
        .text
        .char_indices()
        .map(|(at, _)| {
            marked
                .runs
                .iter()
                .find(|run| run.start <= at && at < run.end)
                .map(|run| run.formats.clone())
                .unwrap_or_default()
        })
        .collect()
}

/// Each committed character's formats, as a view draws them from the projection.
fn drawn_formats(session: &EditorSession, start: usize, text: &str) -> Vec<Vec<InlineFormat>> {
    let slice = session
        .project(session.revision(), range(start, start + text.len()))
        .unwrap();
    text.char_indices()
        .map(|(at, _)| {
            let at = start + at;
            let mut formats: Vec<_> = slice
                .runs
                .iter()
                .find(|run| run.range.start.0 <= at && at < run.range.end.0)
                .map(|run| run.formats.clone())
                .unwrap_or_default();
            formats.sort();
            formats
        })
        .collect()
}

/// Compose a word at `caret` after `toggles`, then commit it: every marked
/// update reports `expected` for each character, and the committed text is
/// drawn the same way.
fn compose_then_commit(
    source: &str,
    caret: usize,
    toggles: &[InlineFormat],
    expected: &[InlineFormat],
) -> String {
    let mut session = EditorSession::open(source);
    session.select(Revision(0), range(caret, caret)).unwrap();
    for format in toggles {
        session
            .toggle_format(session.revision(), *format, &mut |_| Ok(()))
            .unwrap();
    }
    let revision = session.revision();
    for word in ["H", "He", "Hey"] {
        let marked = session
            .compose(revision, range(caret, caret), word)
            .unwrap();
        assert_eq!(
            marked_formats(&marked),
            vec![expected.to_vec(); word.chars().count()],
            "marked {word:?} in {source:?}"
        );
    }
    session
        .commit_composition(revision, None, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(
        drawn_formats(&session, caret, "Hey"),
        vec![expected.to_vec(); 3],
        "committed in {source:?}: {}",
        session.source_text()
    );
    session.source_text()
}

#[test]
fn marked_text_reports_the_carried_formats_it_commits_with() {
    use InlineFormat::*;
    assert_eq!(
        compose_then_commit("text\n", 5, &[Bold], &[Bold]),
        "text\n**Hey**"
    );
    compose_then_commit("text\n", 5, &[Italic], &[Italic]);
    compose_then_commit("text\n", 5, &[Strike], &[Strike]);
    compose_then_commit("text\n", 5, &[Code], &[Code]);
    compose_then_commit("text\n", 5, &[Bold, Italic], &[Bold, Italic]);
    compose_then_commit("# heading\n", 7, &[Bold], &[Bold]);
    assert_eq!(
        compose_then_commit("text\n", 5, &[Bold, Bold], &[]),
        "text\nHey"
    );
}

#[test]
fn marked_text_inside_a_span_reports_that_span_unless_toggled_off() {
    use InlineFormat::*;
    assert_eq!(
        compose_then_commit("a **bold** b", 4, &[], &[Bold]),
        "a **boHeyld** b"
    );
    compose_then_commit("a *it* b", 3, &[], &[Italic]);
    compose_then_commit("a `code` b", 4, &[], &[Code]);
    compose_then_commit("a **bold** b", 4, &[Bold], &[]);
    compose_then_commit("plain", 2, &[], &[]);
}

#[test]
fn reconverted_marked_text_keeps_each_unchanged_characters_formats() {
    let mut session = EditorSession::open("half**way** there");
    // A keyboard reopens the word "halfway" and replaces its "f".
    let marked = session
        .compose(Revision(0), range(0, 7), "halfway")
        .unwrap();
    let bold = vec![InlineFormat::Bold];
    let expected = [
        vec![],
        vec![],
        vec![],
        vec![],
        bold.clone(),
        bold.clone(),
        bold.clone(),
    ];
    assert_eq!(marked_formats(&marked), expected);
    let marked = session
        .compose(Revision(0), range(0, 7), "hallway")
        .unwrap();
    assert_eq!(marked_formats(&marked), expected);
    session
        .commit_composition(Revision(0), None, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), "hall**way** there");
    assert_eq!(drawn_formats(&session, 0, "hallway"), expected);
}

#[test]
fn a_reconversion_across_formats_reports_what_its_commit_draws() {
    let mut session = EditorSession::open("a **bc**");
    session.select(Revision(0), range(0, 4)).unwrap();
    // The changed stretch is the one the commit replaces, so it is formatted
    // like the first character it replaces, not like the whole selection.
    let marked = session.compose(Revision(0), range(0, 4), "a xc").unwrap();
    let reported = marked_formats(&marked);
    session
        .commit_composition(Revision(0), None, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), "a **xc**");
    assert_eq!(drawn_formats(&session, 0, "a xc"), reported);
}
