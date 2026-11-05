use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession, Revision};
mod common;
use common::ReferenceView;

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

/// Compare complete public semantics/correspondence after each reference-view action.
fn assert_fresh(session: &EditorSession, view: &ReferenceView) {
    assert_eq!(session.display_text(), view.text);
    let fresh = EditorSession::open(&session.source_text());
    assert_eq!(fresh.display_text(), view.text);
    let all = range(0, view.text.len());
    let mut incremental = session.project(session.revision(), all).unwrap();
    incremental.revision = Revision(0);
    assert_eq!(incremental, fresh.project(Revision(0), all).unwrap());
}

#[path = "inline/code.rs"]
mod code;
#[path = "inline/correspondence.rs"]
mod correspondence;
#[path = "inline/work.rs"]
mod work;

#[test]
fn nested_inline_marks_render_without_rewriting_the_original_spelling() {
    let original = "__bold *日😀*__ ~~gone~~ ``a ` *b*`` unmatched**\r\n";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("bold 日😀 gone a ` *b* unmatched**\r\n");
    assert_eq!(session.display_text(), view.text);
    assert_eq!(session.source_text(), original);
    let change = session
        .replace(Revision(0), range(5, 8), "中", &mut |_| Ok(()))
        .unwrap();
    view.apply(change);
    assert_fresh(&session, &view);
    assert_eq!(
        session.source_text(),
        "__bold *中😀*__ ~~gone~~ ``a ` *b*`` unmatched**\r\n"
    );
    assert_eq!(view.text, "bold 中😀 gone a ` *b* unmatched**\r\n");
    assert_eq!(session.selection(), range(8, 8));
    assert_eq!(
        EditorSession::open(&session.source_text()).display_text(),
        view.text
    );
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_fresh(&session, &view);
    assert_eq!(view.text, "bold 中😀 gone a ` *b* unmatched**\r\n");
}

#[test]
fn hidden_boundaries_have_explicit_affinity_and_native_coordinates_remain_display_only() {
    use futo_notes_editor::{
        Affinity, DisplayUtf16Offset, DisplayUtf16Range, InlineFormat, SourceOffset,
    };
    let mut session = EditorSession::open("**😀**_日_");
    let projection = session.project(Revision(0), range(0, 7)).unwrap();
    assert_eq!(projection.text, "😀日");
    assert_eq!(
        projection
            .runs
            .iter()
            .map(|run| (run.range, run.formats.clone()))
            .collect::<Vec<_>>(),
        vec![
            (range(0, 4), vec![InlineFormat::Bold]),
            (range(4, 7), vec![InlineFormat::Italic])
        ]
    );
    assert_eq!(
        session
            .source_at(Revision(0), DisplayOffset(4), Affinity::Backward)
            .unwrap(),
        SourceOffset(6)
    );
    assert_eq!(
        session
            .source_at(Revision(0), DisplayOffset(4), Affinity::Forward)
            .unwrap(),
        SourceOffset(9)
    );
    assert!(projection
        .correspondence
        .iter()
        .any(|part| part.display == range(4, 4)
            && part.source.start == SourceOffset(6)
            && part.source.end == SourceOffset(9)));
    assert_eq!(
        session
            .display_from_utf16(
                Revision(0),
                DisplayUtf16Range {
                    start: DisplayUtf16Offset(2),
                    end: DisplayUtf16Offset(3)
                }
            )
            .unwrap(),
        range(4, 7)
    );
    session
        .select_with_affinity(Revision(0), range(4, 4), Affinity::Forward)
        .unwrap();
    let mut view = ReferenceView::new("😀日");
    view.apply(
        session
            .replace(Revision(0), range(4, 4), "中", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "**😀**_中日_");
    assert_eq!(view.text, "😀中日");
    assert_eq!(session.selection(), range(7, 7));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_fresh(&session, &view);
    assert_eq!(session.affinity(), Affinity::Forward);
    assert_eq!(session.selection(), range(4, 4));
    assert_eq!(session.source_text(), "**😀**_日_");
}

#[test]
fn replacement_spanning_adjacent_marks_retains_surviving_styles_and_exact_history() {
    let original = "__ab__*cd* tail\t\r\n";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("abcd tail\t\r\n");
    session.select(Revision(0), range(1, 3)).unwrap();
    view.apply(
        session
            .replace(Revision(0), range(1, 3), "中", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(view.text, "a中d tail\t\r\n");
    assert_eq!(session.source_text(), "__a中__*d* tail\t\r\n");
    assert_eq!(session.selection(), range(4, 4));
    assert_eq!(
        EditorSession::open(&session.source_text()).display_text(),
        view.text
    );
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), original);
    assert_eq!(session.selection(), range(1, 3));
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "__a中__*d* tail\t\r\n");
}

#[test]
fn deleting_all_marked_text_carries_style_and_typing_space_does_not_reveal_markers() {
    use futo_notes_editor::InlineFormat;
    let mut session = EditorSession::open("__日😀__ end");
    let mut view = ReferenceView::new("日😀 end");
    session.select(Revision(0), range(0, 7)).unwrap();
    view.apply(
        session
            .replace(Revision(0), range(0, 7), "", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), " end");
    assert_eq!(view.text, " end");
    assert_eq!(session.active_formats(), vec![InlineFormat::Bold]);
    view.apply(
        session
            .replace(Revision(1), range(0, 0), "word ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "**word**  end");
    assert_eq!(view.text, "word  end");
    assert_eq!(session.selection(), range(5, 5));
    view.apply(
        session
            .replace(Revision(2), range(5, 5), "next", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "**word next** end");
    assert_eq!(view.text, "word next end");
    assert_eq!(session.selection(), range(9, 9));
    assert_eq!(
        EditorSession::open(&session.source_text()).display_text(),
        view.text
    );
}

#[test]
fn formatting_commands_keep_display_selection_and_preserve_unaffected_spellings() {
    use futo_notes_editor::InlineFormat::{Bold, Code, Italic, Strike};
    let mut session = EditorSession::open("__alpha__ beta\t\r\n");
    let mut view = ReferenceView::new("alpha beta\t\r\n");
    session.select(Revision(0), range(6, 10)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(0), Italic, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "__alpha__ *beta*\t\r\n");
    assert_eq!(view.text, "alpha beta\t\r\n");
    assert_eq!(session.selection(), range(6, 10));
    view.apply(
        session
            .toggle_format(Revision(1), Strike, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "__alpha__ ~~*beta*~~\t\r\n");
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "__alpha__ *beta*\t\r\n");
    view.apply(
        session
            .toggle_format(Revision(3), Italic, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "__alpha__ beta\t\r\n");
    session.select(Revision(4), range(0, 5)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(4), Bold, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "alpha beta\t\r\n");
    session.select(Revision(5), range(6, 6)).unwrap();
    assert!(session
        .toggle_format(Revision(5), Code, &mut |_| panic!(
            "collapsed command must not persist source"
        ))
        .unwrap()
        .is_none());
    view.apply(
        session
            .replace(Revision(5), range(6, 6), "*x*", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "alpha `*x*`beta\t\r\n");
    assert_eq!(view.text, "alpha *x*beta\t\r\n");
}

#[test]
fn reviewed_hidden_boundary_cases_keep_literal_view_and_exact_undo() {
    // Compact adaptations of spike untouched_bytes/span_replace/format-sweep
    // cases. Expected views are literal rather than another parser's output.
    for (source, display) in [
        ("**ab**_cd_~~ef~~", "abcdef"),
        ("***日x*** and __b__", "日x and b"),
        ("_._ **12:** foo_bar", ". 12: foo_bar"),
        ("`` a ` b ``", "a ` b"),
        ("`**b** [[x]] #tag`", "**b** [[x]] #tag"),
        ("`a\r\nb`", "a b"),
        ("a\\*b &amp; c", "a*b & c"),
        ("*one\ntwo*\r\n\r\n__tail__  ", "one\ntwo\r\n\r\ntail  "),
        ("*__#_#__*", "#_#"),
    ] {
        let boundaries: Vec<_> = display
            .char_indices()
            .map(|(i, _)| i)
            .chain(std::iter::once(display.len()))
            .collect();
        for &at in &boundaries {
            let mut session = EditorSession::open(source);
            let mut view = ReferenceView::new(display);
            assert_eq!(session.display_text(), display, "open {source:?}");
            view.apply(
                session
                    .replace(Revision(0), range(at, at), "x", &mut |_| Ok(()))
                    .unwrap(),
            );
            assert_fresh(&session, &view);
            let mut expected = display.to_owned();
            expected.insert(at, 'x');
            assert_eq!(view.text, expected, "insert {source:?} at {at}");
            assert_eq!(session.selection(), range(at + 1, at + 1));
            assert_eq!(
                EditorSession::open(&session.source_text()).display_text(),
                expected
            );
            view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
            assert_fresh(&session, &view);
            assert_eq!(session.source_text(), source);
            assert_eq!(view.text, display);
        }
        for pair in boundaries.windows(2) {
            let mut session = EditorSession::open(source);
            let mut view = ReferenceView::new(display);
            view.apply(
                session
                    .replace(Revision(0), range(pair[0], pair[1]), "", &mut |_| Ok(()))
                    .unwrap_or_else(|error| panic!("delete {source:?} {pair:?}: {error}")),
            );
            assert_fresh(&session, &view);
            let mut expected = display.to_owned();
            expected.replace_range(pair[0]..pair[1], "");
            assert_eq!(view.text, expected, "delete {source:?} at {pair:?}");
            assert_eq!(session.selection(), range(pair[0], pair[0]));
            assert_eq!(
                EditorSession::open(&session.source_text()).display_text(),
                expected
            );
            view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
            assert_fresh(&session, &view);
            assert_eq!(session.source_text(), source);
        }
    }
}

#[test]
fn deleting_a_separator_repairs_only_the_flanking_scalar_without_dropping_marks() {
    use futo_notes_editor::InlineFormat::{Bold, Italic};
    let original = "***日😀*** and __b__";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("日😀 and b");
    view.apply(
        session
            .replace(Revision(0), range(7, 8), "", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "***日😀***&#97;nd __b__");
    assert_eq!(view.text, "日😀and b");
    assert_eq!(
        session.project(Revision(1), range(0, 7)).unwrap().runs[0].formats,
        vec![Bold, Italic]
    );
    assert_eq!(session.selection(), range(7, 7));
    view.apply(
        session
            .replace(Revision(1), range(7, 8), "A", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "***日😀***&#65;nd __b__");
    assert_eq!(view.text, "日😀And b");
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_fresh(&session, &view);
    view.apply(session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), original);
}

#[test]
fn inline_interpretation_does_not_enter_fenced_code_across_blank_lines() {
    let source =
        "before **bold**\n\n```md\n**literal**\n\n_unchanged_ [[x]] #tag\n```\n\nafter ~~gone~~";
    let display = "before bold\n\n**literal**\n\n_unchanged_ [[x]] #tag\n\nafter gone";
    let mut session = EditorSession::open(source);
    let mut view = ReferenceView::new(display);
    assert_eq!(session.display_text(), display);
    view.apply(
        session
            .replace(Revision(0), range(7, 8), "B", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(
        session.source_text(),
        "before **Bold**\n\n```md\n**literal**\n\n_unchanged_ [[x]] #tag\n```\n\nafter ~~gone~~"
    );
    assert_eq!(
        EditorSession::open(&session.source_text()).display_text(),
        view.text
    );
}

#[test]
fn a_foreign_range_inside_a_decoded_entity_preserves_the_other_unicode_scalar() {
    let mut session = EditorSession::open("__&NotEqualTilde;__ tail");
    let mut view = ReferenceView::new("≂\u{338} tail");
    assert_eq!(session.display_text(), view.text);
    view.apply(
        session
            .replace(Revision(0), range(3, 5), "", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(view.text, "≂ tail");
    assert_eq!(session.source_text(), "__&#8770;__ tail");
    assert_eq!(session.selection(), range(3, 3));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "__&NotEqualTilde;__ tail");
}

#[test]
fn rejected_inline_operations_preserve_source_projection_selection_affinity_and_history() {
    use futo_notes_editor::{
        Affinity, EditorError, InlineFormat, SourceOffset, SourceRange, SourceUtf16Offset,
        SourceUtf16Range,
    };
    let mut session = EditorSession::open("__😀__ tail");
    session
        .select_with_affinity(Revision(0), range(0, 4), Affinity::Forward)
        .unwrap();
    let original = session.project(Revision(0), range(0, 9)).unwrap();
    let mut refuse = |_: &futo_notes_editor::SourceEdit| Err("no recovery capacity".to_owned());
    assert_eq!(
        session.toggle_format(Revision(0), InlineFormat::Strike, &mut refuse),
        Err(EditorError::Persistence("no recovery capacity".to_owned()))
    );
    assert_eq!(
        session.replace(Revision(0), range(0, 4), "日", &mut refuse),
        Err(EditorError::Persistence("no recovery capacity".to_owned()))
    );
    assert_eq!(session.source_text(), "__😀__ tail");
    assert_eq!(session.project(Revision(0), range(0, 9)).unwrap(), original);
    assert_eq!(session.selection(), range(0, 4));
    assert_eq!(session.affinity(), Affinity::Forward);
    assert_eq!(
        session
            .source_from_utf16(
                Revision(0),
                SourceUtf16Range {
                    start: SourceUtf16Offset(2),
                    end: SourceUtf16Offset(4)
                }
            )
            .unwrap(),
        SourceRange {
            start: SourceOffset(2),
            end: SourceOffset(6)
        }
    );
    assert_eq!(
        session.source_from_utf16(
            Revision(0),
            SourceUtf16Range {
                start: SourceUtf16Offset(3),
                end: SourceUtf16Offset(4)
            }
        ),
        Err(EditorError::InvalidRange)
    );
    assert!(session
        .undo(Revision(0), &mut |_| panic!(
            "rejected edit entered history"
        ))
        .unwrap()
        .is_none());
    assert!(matches!(
        session.project(Revision(1), range(0, 9)),
        Err(EditorError::StaleRevision { .. })
    ));
}

#[test]
fn replacement_at_a_new_hidden_boundary_reports_the_affinity_used_for_input() {
    use futo_notes_editor::{Affinity, InlineFormat};
    let mut session = EditorSession::open("**a**_b_");
    let mut view = ReferenceView::new("ab");
    let change = session
        .replace(Revision(0), range(1, 1), "x", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(change.affinity, Affinity::Backward);
    view.apply(change);
    assert_eq!(session.affinity(), Affinity::Backward);
    assert_eq!(session.active_formats(), vec![InlineFormat::Bold]);
    assert_eq!(session.source_text(), "**ax**_b_");
    assert_eq!(session.selection(), range(2, 2));
    assert_fresh(&session, &view);
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.affinity(), Affinity::Forward);
    assert_eq!(session.selection(), range(0, 0));
    assert_fresh(&session, &view);
}

#[path = "inline/entities.rs"]
mod entities;

#[test]
fn backspace_keeps_the_carets_carried_format() {
    use futo_notes_editor::{InlineFormat, InputAction, ParagraphKey, SourceEdit};
    // A keyboard's double-space period: italic text, a space, then the
    // keyboard deletes that space and commits ". ". The italic continues.
    let ok = &mut |_: &SourceEdit| -> Result<(), String> { Ok(()) };
    let mut s = EditorSession::open("");
    s.toggle_format(s.revision(), InlineFormat::Italic, ok)
        .unwrap();
    for typed in ["abc", " "] {
        let at = s.selection();
        s.replace_action(s.revision(), at, typed, InputAction::Typing, ok)
            .unwrap();
    }
    let at = s.selection();
    s.paragraph_key(s.revision(), at, ParagraphKey::Backspace, ok)
        .unwrap();
    assert_eq!(s.active_formats(), vec![InlineFormat::Italic]);
    for typed in [". ", "x"] {
        let at = s.selection();
        s.replace_action(s.revision(), at, typed, InputAction::Typing, ok)
            .unwrap();
    }
    assert_eq!(s.source_text(), "*abc. x*");
}

#[path = "inline/stacked_formats.rs"]
mod stacked_formats;

#[path = "inline/toolbar_refusals.rs"]
mod toolbar_refusals;

#[path = "inline/toolbar.rs"]
mod toolbar;

#[path = "inline/multi_block.rs"]
mod multi_block;
