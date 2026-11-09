use super::*;
use futo_notes_editor::EditorError;

#[test]
fn an_unchanged_softline_label_only_changes_the_destination() {
    for (original, display, target, label, expected) in [
        (
            "alpha\nbeta",
            "alpha\nbeta",
            range(0, 9),
            "alpha\nbet",
            "[alpha\nbet](<https://new.test>)a",
        ),
        (
            "alpha\r\nbeta",
            "alpha\r\nbeta",
            range(0, 10),
            "alpha\r\nbet",
            "[alpha\r\nbet](<https://new.test>)a",
        ),
        (
            "**North woods**\nSouth river\nEast field",
            "North woods\nSouth river\nEast field",
            range(6, 23),
            "woods\nSouth river",
            "**North [woods](<https://new.test>)**[\nSouth river](<https://new.test>)\nEast field",
        ),
    ] {
        // Both public commands set a destination without replacing any label text.
        let mut destination_only = EditorSession::open(original);
        destination_only
            .set_link(Revision(0), target, "https://new.test", &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(destination_only.source_text(), expected);

        let mut session = EditorSession::open(original);
        session.select(Revision(0), target).unwrap();
        let mut view = ReferenceView::new(display);
        let mut accepted = 0;
        view.apply(
            session
                .edit_link(Revision(0), target, label, "https://new.test", &mut |_| {
                    accepted += 1;
                    Ok(())
                })
                .unwrap()
                .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(view.text, display);
        assert_eq!(session.source_text(), expected);
        assert_eq!(session.selection(), target);
        view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), original);
        assert_eq!(session.selection(), target);
        view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), expected);
        assert_eq!(view.text, display);
    }
}

#[test]
fn new_invalid_link_labels_still_reject_before_acceptance() {
    for (label, composing) in ["new\nlabel", "new\rlabel", "new\0label"]
        .into_iter()
        .flat_map(|label| [false, true].map(|composing| (label, composing)))
    {
        let mut session = EditorSession::open("alpha\nbeta");
        let target = range(0, 5);
        session.select(Revision(0), target).unwrap();
        if composing {
            session.compose(Revision(0), target, "draft").unwrap();
        }
        assert!(matches!(
            session.edit_link(Revision(0), target, label, "/new", &mut |_| panic!(
                "invalid new label accepted"
            )),
            Err(EditorError::InvalidText)
        ));
        assert_eq!(session.source_text(), "alpha\nbeta");
        assert_eq!(session.revision(), Revision(0));
        assert_eq!(session.composition().is_some(), composing);
        if composing {
            assert_eq!(session.composition().unwrap().text, "draft");
        } else {
            assert_eq!(session.selection(), target);
            assert!(session
                .undo(Revision(0), &mut |_| Ok(()))
                .unwrap()
                .is_none());
        }
    }
}
