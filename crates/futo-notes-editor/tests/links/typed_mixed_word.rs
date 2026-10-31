//! A mixed bulk action has one actual last-word owner, not a substring URL seed.
use super::*;

fn mixed(prefix: &str) {
    let inserted = "prefix <www.x.test/path> ";
    let shown = format!("{prefix}{inserted}");
    let candidate = format!("{prefix}prefix <[www.x.test/path](<http://www.x.test/path>)> ");
    let fresh = EditorSession::open(&candidate);
    assert_eq!(fresh.display_text(), shown);
    let expected = fresh
        .project(Revision(0), range(0, shown.len()))
        .unwrap()
        .links;
    assert_eq!(expected.len(), 1);
    assert_eq!(
        expected[0].range,
        range(prefix.len() + 8, prefix.len() + 23)
    );
    assert_eq!(expected[0].destination, "http://www.x.test/path");
    let mut editor = EditorSession::open("");
    if !prefix.is_empty() {
        editor
            .replace(Revision(0), range(0, 0), prefix, &mut |_| Ok(()))
            .unwrap();
        assert_eq!(editor.source_text(), prefix);
        assert!(editor
            .project(Revision(1), range(0, prefix.len()))
            .unwrap()
            .links
            .is_empty());
    }
    let mut accepted = 0;
    editor.replace(editor.revision(), range(prefix.len(), prefix.len()), inserted, &mut |_| { accepted += 1; Ok(()) }).unwrap_or_else(|error| panic!("actual mixed input must accept; prefix={prefix:?}; accepts={accepted}; error={error:?}"));
    assert_eq!(accepted, 1);
    assert_eq!(editor.display_text(), shown);
    assert_eq!(editor.selection(), range(shown.len(), shown.len()));
    assert_eq!(
        editor
            .project(editor.revision(), range(0, shown.len()))
            .unwrap()
            .links,
        expected,
        "accepted={accepted}; source={:?}",
        editor.source_text()
    );
    let source = editor.source_text();
    let saved = EditorSession::open(&source);
    assert_eq!(saved.display_text(), shown);
    assert_eq!(
        saved
            .project(Revision(0), range(0, shown.len()))
            .unwrap()
            .links,
        expected
    );
    editor
        .undo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), prefix);
    assert_eq!(editor.display_text(), prefix);
    editor
        .redo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), source);
    assert_eq!(
        editor
            .project(editor.revision(), range(0, shown.len()))
            .unwrap()
            .links,
        expected
    );
}
#[test]
fn mixed_bulk_seed_links_its_actual_last_angle_word() {
    mixed("");
}
#[test]
fn mixed_bulk_continuation_retires_old_word_and_links_its_actual_last_angle_word() {
    mixed("<www.x.test/");
}
