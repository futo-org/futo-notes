//! Complete retained escape atoms are source witnesses, not plain bytes.
use super::*;

#[test]
fn a_valid_typed_uri_retirement_keeps_complete_foreign_escape_atoms() {
    let old = "<www.x.test/[[Old]]/a*b*c";
    let source = "<www.x.test/[[Old]]/a&#42;b&#42;c";
    let expected = "<www.x.test/[[New Name]]/a&#42;b&#42;c";
    let shown = "<www.x.test/[[New Name]]/a*b*c";
    let bare = EditorSession::open(&old[1..]);
    assert_eq!(
        bare.inspect_link(Revision(0), range(0, 1))
            .unwrap()
            .unwrap()
            .range,
        range(0, old.len() - 1)
    );
    let standard = EditorSession::open(expected);
    assert_eq!(standard.display_text(), shown);
    let proof = standard
        .project(Revision(0), range(0, shown.len()))
        .unwrap();
    assert!(proof.links.is_empty());
    assert!(proof.runs.iter().all(|run| run.formats.is_empty()));
    let mut editor = EditorSession::open("");
    editor
        .replace(Revision(0), range(0, 0), old, &mut |_| Ok(()))
        .unwrap();
    assert_eq!(
        editor.source_text(),
        source,
        "actual Typing owns complete encoded star atoms"
    );
    let action = OwnActionRelink {
        mappings: vec![("Old".into(), "New Name".into())],
        note_ids: vec!["Old".into()],
    };
    let star = old.find('*').unwrap();
    editor
        .select_with_affinity(Revision(1), range(star, star + 1), Affinity::Backward)
        .unwrap();
    editor
        .replace_action(
            Revision(1),
            range(0, 0),
            "!",
            InputAction::Isolated,
            &mut |_| Ok(()),
        )
        .unwrap();
    editor
        .undo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), source);
    let revision = editor.revision();
    let selected = editor.selection();
    let projection = editor.project(revision, range(0, old.len())).unwrap();
    let mut refused = 0;
    assert!(matches!(
        editor.apply_own_relink(revision, &action, &mut |_| {
            refused += 1;
            Err("injected retained-atom refusal".into())
        }),
        Err(EditorError::Persistence(_))
    ));
    assert_eq!(refused, 1);
    assert_eq!(editor.revision(), revision);
    assert_eq!(editor.source_text(), source);
    assert_eq!(editor.selection(), selected);
    assert_eq!(
        editor.project(revision, range(0, old.len())).unwrap(),
        projection
    );
    let mut accepted = 0;
    editor.apply_own_relink(revision, &action, &mut |_| { accepted += 1; Ok(()) })
        .unwrap_or_else(|error| panic!("complete retained atoms outside canonical emission must survive; accepted={accepted}; error={error:?}")).unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(editor.source_text(), expected);
    assert_eq!(editor.display_text(), shown);
    let actual = editor
        .project(editor.revision(), range(0, shown.len()))
        .unwrap();
    assert_eq!(actual.links, proof.links);
    assert_eq!(actual.runs, proof.runs);
    let star = shown.find('*').unwrap();
    assert_eq!(editor.selection(), range(star, star + 1));
    assert_eq!(editor.affinity(), Affinity::Backward);
    assert!(editor
        .inspect_link(editor.revision(), editor.selection())
        .unwrap()
        .is_none());
    editor
        .redo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), format!("!{expected}"));
    editor
        .undo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), expected);
    assert_eq!(editor.selection(), range(star, star + 1));
    editor
        .undo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), "");
    editor
        .redo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), expected);
    let mut loaded = EditorSession::open(expected);
    for target in [&mut editor, &mut loaded] {
        target
            .replace(
                target.revision(),
                range(shown.len(), shown.len()),
                ">",
                &mut |_| Ok(()),
            )
            .unwrap();
        target
            .replace(
                target.revision(),
                range(shown.len() + 1, shown.len() + 1),
                " ",
                &mut |_| Ok(()),
            )
            .unwrap();
        assert_eq!(target.display_text(), format!("{shown}> "));
        assert!(target
            .project(target.revision(), range(0, shown.len() + 2))
            .unwrap()
            .links
            .is_empty());
    }
    assert_eq!(editor.source_text(), loaded.source_text());
}
