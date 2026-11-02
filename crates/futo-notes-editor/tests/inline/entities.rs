use super::{assert_fresh, range, ReferenceView};
use futo_notes_editor::{
    Affinity, CorrespondenceKind, DisplayOffset, DisplayUtf16Offset, DisplayUtf16Range,
    EditorSession, InlineFormat, Revision, SourceOffset, SourceRange, SourceUtf16Offset,
    SourceUtf16Range,
};

#[test]
fn equal_byte_length_entities_keep_transformed_source_boundaries() {
    for (source, backward, forward) in [("&acE;", 0, 5), ("__&acE;__", 2, 7)] {
        let session = EditorSession::open(source);
        assert_eq!(session.display_text(), "∾\u{333}");
        assert_eq!(session.source_text(), source);
        assert_eq!(
            session
                .source_at(Revision(0), DisplayOffset(3), Affinity::Backward)
                .unwrap(),
            SourceOffset(backward),
        );
        assert_eq!(
            session
                .source_at(Revision(0), DisplayOffset(3), Affinity::Forward)
                .unwrap(),
            SourceOffset(forward),
        );
        let projection = session.project(Revision(0), range(0, 5)).unwrap();
        let source_range = SourceRange {
            start: SourceOffset(backward),
            end: SourceOffset(forward),
        };
        assert!(projection
            .correspondence
            .iter()
            .any(|part| part.source == source_range
                && part.display == range(0, 5)
                && part.kind == CorrespondenceKind::Replaced));
        let utf16 = DisplayUtf16Range {
            start: DisplayUtf16Offset(1),
            end: DisplayUtf16Offset(2),
        };
        assert_eq!(
            session.display_from_utf16(Revision(0), utf16).unwrap(),
            range(3, 5)
        );
        assert_eq!(
            session.display_to_utf16(Revision(0), range(3, 5)).unwrap(),
            utf16
        );
        let source_utf16 = SourceUtf16Range {
            start: SourceUtf16Offset(backward),
            end: SourceUtf16Offset(forward),
        };
        assert_eq!(
            session
                .source_from_utf16(Revision(0), source_utf16)
                .unwrap(),
            source_range
        );
        assert_eq!(
            session.source_to_utf16(Revision(0), source_range).unwrap(),
            source_utf16
        );
    }
}

#[test]
fn replacing_either_entity_scalar_preserves_marks_and_exact_history() {
    for (selected, source, display, caret) in [
        (range(0, 3), "__x&#819;__ tail", "x\u{333} tail", 1),
        (range(3, 5), "__&#8766;x__ tail", "∾x tail", 4),
    ] {
        let original = "__&acE;__ tail";
        let mut session = EditorSession::open(original);
        let mut view = ReferenceView::new("∾\u{333} tail");
        session
            .select_with_affinity(Revision(0), selected, Affinity::Backward)
            .unwrap();
        view.apply(
            session
                .replace(Revision(0), selected, "x", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_fresh(&session, &view);
        assert_eq!(view.text, display);
        assert_eq!(session.source_text(), source);
        assert_eq!(session.selection(), range(caret, caret));
        assert_eq!(session.active_formats(), vec![InlineFormat::Bold]);
        assert_eq!(
            session.project(Revision(1), range(0, caret)).unwrap().runs[0].formats,
            vec![InlineFormat::Bold]
        );
        view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_fresh(&session, &view);
        assert_eq!(session.source_text(), original);
        assert_eq!(view.text, "∾\u{333} tail");
        assert_eq!(session.selection(), selected);
        assert_eq!(session.affinity(), Affinity::Backward);
        view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_fresh(&session, &view);
        assert_eq!(session.source_text(), source);
        assert_eq!(view.text, display);
        assert_eq!(session.selection(), range(caret, caret));
        assert_eq!(session.active_formats(), vec![InlineFormat::Bold]);
    }
}
