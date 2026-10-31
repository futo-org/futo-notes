//! The existing actual WWW seed may change canonical URI class under a rename.
use super::*;

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
    let mut accepted = 0;
    editor.apply_own_relink(Revision(1), &action, &mut |_| { accepted += 1; Ok(()) })
        .unwrap_or_else(|error| panic!("representable typed URI retirement must accept; accepted={accepted}; error={error:?}")).unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(editor.source_text(), format!("<{new}"));
    assert_eq!(editor.display_text(), standard.display_text());
    assert!(editor
        .project(editor.revision(), range(0, new.len() + 1))
        .unwrap()
        .links
        .is_empty());
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
    let mut accepted = 0;
    editor.apply_own_relink(Revision(1), &action, &mut |_| { accepted += 1; Ok(()) })
        .unwrap_or_else(|error| panic!("existing typed seed gains canonical whole meaning; accepted={accepted}; error={error:?}")).unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(editor.source_text(), format!("<{new}"));
    assert_eq!(editor.display_text(), standard.display_text());
    let end = new.len() + 1;
    editor
        .replace(editor.revision(), range(end, end), ">", &mut |_| Ok(()))
        .unwrap();
    editor
        .replace(editor.revision(), range(end + 1, end + 1), " ", &mut |_| {
            Ok(())
        })
        .unwrap();
    assert_eq!(
        editor
            .inspect_link(editor.revision(), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        format!("http://{new}")
    );
}
