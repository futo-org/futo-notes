use super::*;

#[test]
fn a_partial_compound_draft_escalates_before_mapping_targets_past_a_remote_definition() {
    use futo_notes_editor::DisplayReplacement;
    let original = "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n[one][id]\n\nbody\n\ntail";
    let changed = "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n\n\nBODY\n\ntail";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("preamble\n\nbuffer\n\none\n\nbody\n\ntail");
    assert_eq!(session.display_text(), view.text);
    let mut accepted = 0;
    view.apply(
        session
            .replace_many(
                Revision(0),
                &[
                    DisplayReplacement {
                        range: range(18, 21),
                        inserted: String::new(),
                    },
                    DisplayReplacement {
                        range: range(23, 27),
                        inserted: "BODY".into(),
                    },
                ],
                &mut |_| {
                    accepted += 1;
                    Ok(())
                },
            )
            .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), changed);
    assert_eq!(view.text, changed);
    assert_eq!(session.selection(), range(43, 43));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, "preamble\n\nbuffer\n\none\n\nbody\n\ntail");
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), changed);
    assert_eq!(session.selection(), range(43, 43));
}
