//! Canonical eligibility precedes any policy for a truly rewritten live word.
use super::*;

#[test]
fn a_canonical_rewrite_inside_a_whole_code_uri_reaches_acceptance() {
    let uri = "https://x.test/[[Old]]/path";
    let next_uri = "https://x.test/[[New]]/path";
    for word in [uri, next_uri] {
        let bare = EditorSession::open(word);
        let inspected = bare.inspect_link(Revision(0), range(0, 1)).unwrap().expect(
            "the affected-field candidate must be one canonical full URI before any live command",
        );
        assert_eq!(
            inspected.range,
            range(0, word.len()),
            "bare candidate {word:?}"
        );
        let closed = EditorSession::open(&format!("<<{word}>>"));
        assert_eq!(closed.display_text(), format!("<{word}>"));
        let canonical = closed
            .inspect_link(Revision(0), range(1, 2))
            .unwrap()
            .unwrap();
        assert_eq!(canonical.range, range(1, word.len() + 1));
        assert_eq!(canonical.destination, inspected.destination);
        let code = EditorSession::open(&format!("<`{word}`>"));
        assert_eq!(code.display_text(), format!("<{word}>"));
        let projection = code.project(Revision(0), range(0, word.len() + 2)).unwrap();
        assert!(projection.links.is_empty());
        assert_eq!(
            projection
                .runs
                .iter()
                .filter(|run| run.formats.contains(&InlineFormat::Code))
                .map(|run| run.range)
                .collect::<Vec<_>>(),
            vec![range(1, word.len() + 1)]
        );
    }
    let end = uri.len() + 1;
    let mut editor = EditorSession::open("");
    let mut view = common::ReferenceView::new("");
    view.apply(
        editor
            .replace(
                Revision(0),
                range(0, 0),
                &format!("<{uri}"),
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(
        editor
            .replace(Revision(1), range(end, end), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, format!("<{uri}>"));
    assert!(editor
        .project(Revision(2), range(0, end + 1))
        .unwrap()
        .links
        .is_empty());
    editor.select(Revision(2), range(1, end)).unwrap();
    view.apply(
        editor
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let original = editor.source_text();
    assert_eq!(original, format!("<`{uri}`>"));
    let guarded = editor.project(Revision(3), range(0, end + 1)).unwrap();
    assert!(guarded.links.is_empty());
    assert_eq!(
        guarded
            .runs
            .iter()
            .filter(|run| run.formats.contains(&InlineFormat::Code))
            .map(|run| run.range)
            .collect::<Vec<_>>(),
        vec![range(1, end)]
    );
    let action = OwnActionRelink {
        mappings: vec![("Old".into(), "New".into())],
        note_ids: vec!["Old".into()],
    };
    let mut calls = 0;
    let change = editor
        .apply_own_relink(Revision(3), &action, &mut |_| {
            calls += 1;
            Ok(())
        })
        .expect("canonical own rename must accept its independently valid changed Code text")
        .unwrap();
    assert_eq!(calls, 1);
    view.apply(change);
    assert_eq!(view.text, format!("<{next_uri}>"));
    assert_eq!(editor.source_text(), format!("<`{next_uri}`>"));
    let query = editor.project(Revision(4), range(0, end + 1)).unwrap();
    assert!(query.links.is_empty());
    assert_eq!(
        query
            .runs
            .iter()
            .filter(|run| run.formats.contains(&InlineFormat::Code))
            .map(|run| run.range)
            .collect::<Vec<_>>(),
        vec![range(1, end)]
    );
    // Post-Code word-end lifetime is deliberately a separate policy proof;
    // this first discriminator establishes valid source and actual mutation.
}
