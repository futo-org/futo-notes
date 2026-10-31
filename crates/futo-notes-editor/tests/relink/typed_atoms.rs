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
    let mut accepted = 0;
    editor.apply_own_relink(Revision(1), &action, &mut |_| { accepted += 1; Ok(()) })
        .unwrap_or_else(|error| panic!("complete retained atoms outside canonical emission must survive; accepted={accepted}; error={error:?}")).unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(editor.source_text(), expected);
    assert_eq!(editor.display_text(), shown);
    let actual = editor
        .project(editor.revision(), range(0, shown.len()))
        .unwrap();
    assert_eq!(actual.links, proof.links);
    assert_eq!(actual.runs, proof.runs);
}
