//! A canonical relink transports an existing typed origin, never a loaded shape.
use super::*;

#[test]
fn an_affected_unclosed_www_origin_keeps_its_actual_typing_lifetime() {
    let old = "www.x.test/[[Old]]/path";
    let new = "www.x.test/[[New]]/path";
    for word in [old, new] {
        let bare = EditorSession::open(word);
        let link = bare
            .inspect_link(Revision(0), range(0, 1))
            .unwrap()
            .expect("candidate must be one canonical whole WWW URI");
        assert_eq!(link.range, range(0, word.len()));
        assert_eq!(link.destination, format!("http://{word}"));
        let unclosed = EditorSession::open(&format!("<{word}"));
        assert_eq!(unclosed.display_text(), format!("<{word}"));
        assert!(unclosed
            .project(Revision(0), range(0, word.len() + 1))
            .unwrap()
            .links
            .is_empty());
    }
    let mut editor = EditorSession::open("");
    let mut view = common::ReferenceView::new("");
    view.apply(
        editor
            .replace(
                Revision(0),
                range(0, 0),
                &format!("<{old}"),
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(editor.source_text(), format!("<{old}"));
    assert!(editor
        .project(Revision(1), range(0, old.len() + 1))
        .unwrap()
        .links
        .is_empty());
    let action = OwnActionRelink {
        mappings: vec![("Old".into(), "New".into())],
        note_ids: vec!["Old".into()],
    };
    view.apply(
        editor
            .apply_own_relink(Revision(1), &action, &mut |_| Ok(()))
            .expect("canonical rename must transport the actual unclosed typed origin")
            .unwrap(),
    );
    assert_eq!(editor.source_text(), format!("<{new}"));
    assert_eq!(view.text, format!("<{new}"));
    let end = new.len() + 1;
    assert!(editor
        .project(Revision(2), range(0, end))
        .unwrap()
        .links
        .is_empty());
    view.apply(
        editor
            .replace(Revision(2), range(end, end), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, format!("<{new}>"));
    assert!(editor
        .project(Revision(3), range(0, end + 1))
        .unwrap()
        .links
        .is_empty());
    view.apply(editor.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), format!("<{new}"));
    view.apply(editor.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(
        editor
            .replace(Revision(5), range(end + 1, end + 1), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, format!("<{new}> "));
    assert_eq!(
        editor
            .inspect_link(Revision(6), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        format!("http://{new}")
    );
    let reopened = EditorSession::open(&editor.source_text());
    assert_eq!(reopened.display_text(), view.text);
    assert_eq!(
        reopened
            .inspect_link(Revision(0), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        format!("http://{new}")
    );
}

#[test]
fn an_actual_ineligible_www_candidate_accepts_the_same_literal_rename_as_loaded_source() {
    let before = "<www.[[Old]]";
    let after = "<www.[[New]]";
    let action = OwnActionRelink {
        mappings: vec![("Old".into(), "New".into())],
        note_ids: vec!["Old".into()],
    };
    for source in [before, after] {
        let canonical = EditorSession::open(source);
        assert_eq!(canonical.display_text(), source);
        assert!(canonical
            .project(Revision(0), range(0, source.len()))
            .unwrap()
            .links
            .is_empty());
        let bare = EditorSession::open(&source[1..]);
        assert!(bare
            .project(Revision(0), range(0, source.len() - 1))
            .unwrap()
            .links
            .is_empty());
    }
    // The actual canonical command must rewrite this exact literal source;
    // a pattern that the emitter never touches cannot prove an owner defect.
    let mut loaded = EditorSession::open(before);
    let mut calls = 0;
    loaded
        .apply_own_relink(Revision(0), &action, &mut |_| {
            calls += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(calls, 1);
    assert_eq!(loaded.source_text(), after);
    assert_eq!(loaded.display_text(), after);
    assert!(loaded
        .project(Revision(1), range(0, after.len()))
        .unwrap()
        .links
        .is_empty());
    let mut editor = EditorSession::open("");
    let mut view = common::ReferenceView::new("");
    view.apply(
        editor
            .replace(Revision(0), range(0, 0), before, &mut |_| Ok(()))
            .expect("actual bulk Typing must accept this bounded WWW candidate"),
    );
    assert_eq!(editor.source_text(), before);
    assert_eq!(view.text, before);
    assert!(editor
        .project(Revision(1), range(0, before.len()))
        .unwrap()
        .links
        .is_empty());
    view.apply(editor.apply_own_relink(Revision(1), &action, &mut |_| Ok(())).expect("the same canonical literal rename must accept an actual ineligible typed candidate").unwrap());
    assert_eq!(editor.source_text(), after);
    assert_eq!(view.text, after);
    let end = after.len();
    view.apply(
        editor
            .replace(Revision(2), range(end, end), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, format!("{after} "));
    assert!(editor
        .project(Revision(3), range(0, end + 1))
        .unwrap()
        .links
        .is_empty());
    view.apply(editor.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), after);
    view.apply(editor.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(view.text, format!("{after} "));
    assert!(editor
        .project(Revision(5), range(0, end + 1))
        .unwrap()
        .links
        .is_empty());
}
