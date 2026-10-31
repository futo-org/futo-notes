//! Shipping plugin word-end intent across committed input and mixed bulk typing.
use super::*;
use futo_notes_editor::InputAction;

#[derive(Debug)]
enum Ending {
    IsolatedSpace,
    MarkedSpace,
    BulkSeed,
    BulkContinuation,
}
fn story(ending: Ending) {
    let expected = "<www.x.test/path ";
    let canonical = EditorSession::open("<[www.x.test/path](<http://www.x.test/path>) ");
    assert_eq!(canonical.display_text(), expected);
    let expected_link = canonical
        .inspect_link(Revision(0), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(expected_link.range, range(1, 16));
    assert_eq!(expected_link.destination, "http://www.x.test/path");
    let mut editor = EditorSession::open("");
    let before = match ending {
        Ending::BulkSeed => "",
        Ending::BulkContinuation => "<www.x.test/",
        _ => "<www.x.test/path",
    };
    if !before.is_empty() {
        editor
            .replace(Revision(0), range(0, 0), before, &mut |_| Ok(()))
            .unwrap();
        assert_eq!(editor.source_text(), before);
        assert!(editor
            .project(Revision(1), range(0, before.len()))
            .unwrap()
            .links
            .is_empty());
        editor.select(Revision(1), range(0, 0)).unwrap();
        editor
            .select(Revision(1), range(before.len(), before.len()))
            .unwrap();
    }
    let opening_revision = editor.revision();
    if matches!(ending, Ending::MarkedSpace) {
        editor
            .compose(opening_revision, range(16, 16), " ")
            .unwrap();
        assert_eq!(editor.source_text(), before);
    }
    let mut accepted = 0;
    let mut accept = |_: &futo_notes_editor::SourceEdit| {
        accepted += 1;
        Ok(())
    };
    let result = match ending {
        Ending::IsolatedSpace => editor.replace_action(
            opening_revision,
            range(16, 16),
            " ",
            InputAction::Isolated,
            &mut accept,
        ),
        Ending::MarkedSpace => editor
            .commit_composition(opening_revision, None, &mut accept)
            .map(|change| change.expect("changed marked Space must produce one delta")),
        Ending::BulkSeed => editor.replace(opening_revision, range(0, 0), expected, &mut accept),
        Ending::BulkContinuation => editor.replace(
            opening_revision,
            range(before.len(), before.len()),
            "path ",
            &mut accept,
        ),
    };
    let change = result.unwrap_or_else(|error| panic!("{ending:?} must accept the shipping word-end intent; accepts={accepted}; error={error:?}"));
    assert_eq!(accepted, 1);
    assert_eq!(change.selection, range(expected.len(), expected.len()));
    assert_eq!(editor.display_text(), expected);
    assert!(editor.composition().is_none());
    assert_eq!(
        editor
            .inspect_link(editor.revision(), range(1, 2))
            .unwrap()
            .unwrap(),
        expected_link
    );
    let source = editor.source_text();
    let fresh = EditorSession::open(&source);
    assert_eq!(fresh.display_text(), expected);
    assert_eq!(
        fresh
            .inspect_link(Revision(0), range(1, 2))
            .unwrap()
            .unwrap(),
        expected_link
    );
    editor
        .undo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), before);
    assert_eq!(editor.display_text(), before);
    editor
        .redo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), source);
    assert_eq!(editor.display_text(), expected);
    assert_eq!(
        editor
            .inspect_link(editor.revision(), range(1, 2))
            .unwrap()
            .unwrap(),
        expected_link
    );
}
#[test]
fn isolated_space_ends_the_supplied_uri_word() {
    story(Ending::IsolatedSpace);
}
#[test]
fn marked_space_ends_the_supplied_uri_word() {
    story(Ending::MarkedSpace);
}
#[test]
fn bulk_typing_seed_ends_its_inserted_uri_word() {
    story(Ending::BulkSeed);
}
#[test]
fn bulk_typing_continuation_ends_its_extended_uri_word() {
    story(Ending::BulkContinuation);
}
