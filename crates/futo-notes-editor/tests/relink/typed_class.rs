//! The existing actual WWW seed may change canonical URI class under a rename.
use super::*;

fn rename_with_refusal_and_history(
    editor: &mut EditorSession,
    action: &OwnActionRelink,
    original: &str,
    expected: &str,
) {
    editor
        .replace_action(
            editor.revision(),
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
    assert_eq!(editor.source_text(), original);
    let revision = editor.revision();
    let selection = editor.selection();
    let affinity = editor.affinity();
    let before = editor.project(revision, range(0, original.len())).unwrap();
    let mut refused = 0;
    assert!(matches!(
        editor.apply_own_relink(revision, action, &mut |_| {
            refused += 1;
            Err("injected typed transition refusal".into())
        }),
        Err(EditorError::Persistence(_))
    ));
    assert_eq!(refused, 1);
    assert_eq!(editor.revision(), revision);
    assert_eq!(editor.source_text(), original);
    assert_eq!(editor.selection(), selection);
    assert_eq!(editor.affinity(), affinity);
    assert_eq!(
        editor.project(revision, range(0, original.len())).unwrap(),
        before
    );
    let mut accepted = 0;
    editor
        .apply_own_relink(revision, action, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(editor.source_text(), expected);
    assert_eq!(editor.display_text(), expected);
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
    let fresh = EditorSession::open(expected);
    assert_eq!(fresh.display_text(), expected);
    assert!(fresh
        .project(Revision(0), range(0, expected.len()))
        .unwrap()
        .links
        .is_empty());
}

#[test]
fn a_valid_rename_can_retire_a_complete_unclosed_www_origin_as_literal() {
    let old = "www.x.test/[[Old]]/path";
    let new = "www.x.test/[[New Name]]/path";
    let old_bare = EditorSession::open(old);
    assert_eq!(
        old_bare
            .inspect_link(Revision(0), range(0, 1))
            .unwrap()
            .unwrap()
            .range,
        range(0, old.len())
    );
    let bare = EditorSession::open(new);
    assert!(
        bare.inspect_link(Revision(0), range(0, 1))
            .unwrap()
            .unwrap()
            .range
            .end
            .0
            < new.len()
    );
    let standard = EditorSession::open(&format!("<{new}"));
    assert_eq!(standard.display_text(), format!("<{new}"));
    assert!(standard
        .project(Revision(0), range(0, new.len() + 1))
        .unwrap()
        .links
        .is_empty());
    let mut editor = EditorSession::open("");
    editor
        .replace(
            Revision(0),
            range(0, 0),
            &format!("<{old}"),
            &mut |_| Ok(()),
        )
        .unwrap();
    let action = OwnActionRelink {
        mappings: vec![("Old".into(), "New Name".into())],
        note_ids: vec!["Old".into()],
    };
    rename_with_refusal_and_history(&mut editor, &action, &format!("<{old}"), &format!("<{new}"));
    assert_eq!(editor.source_text(), format!("<{new}"));
    assert_eq!(editor.display_text(), standard.display_text());
    assert!(editor
        .project(editor.revision(), range(0, new.len() + 1))
        .unwrap()
        .links
        .is_empty());
    let mut loaded = EditorSession::open(&editor.source_text());
    for target in [&mut editor, &mut loaded] {
        let at = new.len() + 1;
        target
            .replace(target.revision(), range(at, at), ">", &mut |_| Ok(()))
            .unwrap();
        target
            .replace(target.revision(), range(at + 1, at + 1), " ", &mut |_| {
                Ok(())
            })
            .unwrap();
        assert!(target
            .project(target.revision(), range(0, at + 2))
            .unwrap()
            .links
            .is_empty());
    }
    assert_eq!(editor.source_text(), loaded.source_text());
}

#[test]
fn a_valid_rename_can_complete_the_existing_partial_www_candidate() {
    // GFM excludes the unmatched terminal close parenthesis. The inserted
    // opening parenthesis in the actual note title balances that SAME scalar.
    let old = "www.x.test/[[Old]]/path)";
    let new = "www.x.test/[[New(]]/path)";
    let old_bare = EditorSession::open(old);
    assert_eq!(
        old_bare
            .inspect_link(Revision(0), range(0, 1))
            .unwrap()
            .unwrap()
            .range,
        range(0, old.len() - 1)
    );
    let new_bare = EditorSession::open(new);
    let whole = new_bare
        .inspect_link(Revision(0), range(0, 1))
        .unwrap()
        .unwrap();
    assert_eq!(whole.range, range(0, new.len()));
    assert_eq!(whole.destination, format!("http://{new}"));
    let standard = EditorSession::open(&format!("<{new}"));
    assert_eq!(standard.display_text(), format!("<{new}"));
    assert!(standard
        .project(Revision(0), range(0, new.len() + 1))
        .unwrap()
        .links
        .is_empty());
    let mut editor = EditorSession::open("");
    editor
        .replace(
            Revision(0),
            range(0, 0),
            &format!("<{old}"),
            &mut |_| Ok(()),
        )
        .unwrap();
    let action = OwnActionRelink {
        mappings: vec![("Old".into(), "New(".into())],
        note_ids: vec!["Old".into()],
    };
    rename_with_refusal_and_history(&mut editor, &action, &format!("<{old}"), &format!("<{new}"));
    assert_eq!(editor.source_text(), format!("<{new}"));
    assert_eq!(editor.display_text(), standard.display_text());
    let mut loaded = EditorSession::open(&editor.source_text());
    let end = new.len() + 1;
    editor
        .replace(editor.revision(), range(end, end), ">", &mut |_| Ok(()))
        .unwrap();
    editor
        .replace(editor.revision(), range(end + 1, end + 1), " ", &mut |_| {
            Ok(())
        })
        .unwrap();
    loaded
        .replace(loaded.revision(), range(end, end), ">", &mut |_| Ok(()))
        .unwrap();
    loaded
        .replace(loaded.revision(), range(end + 1, end + 1), " ", &mut |_| {
            Ok(())
        })
        .unwrap();
    assert_eq!(loaded.display_text(), editor.display_text());
    assert!(loaded
        .project(loaded.revision(), range(0, end + 2))
        .unwrap()
        .links
        .is_empty());
    assert_eq!(
        editor
            .inspect_link(editor.revision(), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        format!("http://{new}")
    );
}
