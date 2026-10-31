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
    let before = editor.project(Revision(3), range(0, end + 1)).unwrap();
    let selection = editor.selection();
    let refused = editor.apply_own_relink(Revision(3), &action, &mut |_| {
        Err("injected affected-owner refusal".into())
    });
    assert!(
        matches!(refused, Err(EditorError::Persistence(_))),
        "valid affected rename must reach acceptance: {refused:?}"
    );
    assert_eq!(editor.source_text(), original);
    assert_eq!(editor.revision(), Revision(3));
    assert_eq!(editor.selection(), selection);
    assert_eq!(
        editor.project(Revision(3), range(0, end + 1)).unwrap(),
        before
    );
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
    view.apply(editor.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(view.text, format!("<{next_uri}>"));
    assert!(editor
        .project(Revision(5), range(0, end + 1))
        .unwrap()
        .links
        .is_empty());
    view.apply(editor.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), format!("<`{next_uri}`>"));
    let restored = editor.project(Revision(6), range(0, end + 1)).unwrap();
    assert_eq!(restored.links, query.links);
    assert_eq!(restored.runs, query.runs);
    editor.select(Revision(6), range(1, end)).unwrap();
    view.apply(
        editor
            .toggle_format(Revision(6), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert!(editor
        .project(Revision(7), range(0, end + 1))
        .unwrap()
        .links
        .is_empty());
    editor.select(Revision(7), range(end + 1, end + 1)).unwrap();
    view.apply(
        editor
            .replace(Revision(7), range(end + 1, end + 1), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, format!("<{next_uri}> "));
    let link = editor
        .inspect_link(Revision(8), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(link.range, range(1, end));
    assert_eq!(link.destination, next_uri);
    let fresh = EditorSession::open(&editor.source_text());
    assert_eq!(fresh.display_text(), view.text);
    assert_eq!(
        fresh
            .inspect_link(Revision(0), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        next_uri
    );
}

#[test]
fn own_rename_of_loaded_code_never_creates_a_typed_uri_owner() {
    let old = "<`https://x.test/[[Old]]/path`>";
    let renamed = "<`https://x.test/[[New]]/path`>";
    let literal = "<https://x.test/[[New]]/path>";
    let mut editor = EditorSession::open(old);
    let mut view = common::ReferenceView::new("<https://x.test/[[Old]]/path>");
    let action = OwnActionRelink {
        mappings: vec![("Old".into(), "New".into())],
        note_ids: vec!["Old".into()],
    };
    view.apply(
        editor
            .apply_own_relink(Revision(0), &action, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(editor.source_text(), renamed);
    assert_eq!(view.text, literal);
    editor
        .select(Revision(1), range(1, literal.len() - 1))
        .unwrap();
    view.apply(
        editor
            .toggle_format(Revision(1), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(view.text, literal);
    editor
        .select(Revision(2), range(literal.len(), literal.len()))
        .unwrap();
    view.apply(
        editor
            .replace(
                Revision(2),
                range(literal.len(), literal.len()),
                " ",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(view.text, format!("{literal} "));
    let current = editor
        .project(Revision(3), range(0, view.text.len()))
        .unwrap();
    assert!(current.links.is_empty());
    let fresh = EditorSession::open(&editor.source_text());
    assert_eq!(fresh.display_text(), view.text);
    assert!(fresh
        .project(Revision(0), range(0, view.text.len()))
        .unwrap()
        .links
        .is_empty());
}

#[test]
fn a_canonical_rewrite_of_only_the_code_wikilink_keeps_the_surrounding_owned_uri() {
    let before = r"<https\://x.test/`[[Old]]`/path>";
    let after = r"<https\://x.test/`[[New]]`/path>";
    for (source, literal) in [
        (before, "<https://x.test/[[Old]]/path>"),
        (after, "<https://x.test/[[New]]/path>"),
    ] {
        let canonical = EditorSession::open(source);
        assert_eq!(canonical.display_text(), literal);
        let query = canonical.project(Revision(0), range(0, 29)).unwrap();
        assert!(query.links.is_empty());
        assert_eq!(
            query
                .runs
                .iter()
                .filter(|run| run.formats.contains(&InlineFormat::Code))
                .map(|run| run.range)
                .collect::<Vec<_>>(),
            vec![range(16, 23)]
        );
    }
    let mut editor = EditorSession::open("");
    let mut view = common::ReferenceView::new("");
    view.apply(
        editor
            .replace(
                Revision(0),
                range(0, 0),
                "<https://x.test/[[Old]]/path",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(
        editor
            .replace(Revision(1), range(28, 28), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    editor.select(Revision(2), range(16, 23)).unwrap();
    view.apply(
        editor
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test/[[Old]]/path>");
    assert_eq!(editor.source_text(), before);
    let action = OwnActionRelink {
        mappings: vec![("Old".into(), "New".into())],
        note_ids: vec!["Old".into()],
    };
    view.apply(
        editor
            .apply_own_relink(Revision(3), &action, &mut |_| Ok(()))
            .expect("the actual partial Code URI has a proven standard-source rename")
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test/[[New]]/path>");
    assert_eq!(editor.source_text(), after);
    let query = editor.project(Revision(4), range(0, 29)).unwrap();
    assert!(query.links.is_empty());
    assert_eq!(
        query
            .runs
            .iter()
            .filter(|run| run.formats.contains(&InlineFormat::Code))
            .map(|run| run.range)
            .collect::<Vec<_>>(),
        vec![range(16, 23)]
    );
    editor.select(Revision(4), range(16, 23)).unwrap();
    view.apply(
        editor
            .toggle_format(Revision(4), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    editor.select(Revision(5), range(29, 29)).unwrap();
    view.apply(
        editor
            .replace(Revision(5), range(29, 29), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test/[[New]]/path> ");
    let link = editor
        .inspect_link(Revision(6), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(link.range, range(1, 28));
    assert_eq!(link.destination, "https://x.test/[[New]]/path");
}

#[test]
fn equal_uri_owners_keep_distinct_lifetimes_after_the_same_canonical_rewrite() {
    let uri = "https://x.test/[[Old]]/path";
    let next = "https://x.test/[[New]]/path";
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
            .replace(Revision(1), range(28, 28), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    editor.select(Revision(2), range(1, 28)).unwrap();
    view.apply(
        editor
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    view.apply(
        editor
            .replace(Revision(3), range(29, 29), &format!(" <{uri}"), &mut |_| {
                Ok(())
            })
            .unwrap(),
    );
    view.apply(
        editor
            .replace(Revision(4), range(58, 58), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    editor.select(Revision(5), range(31, 58)).unwrap();
    view.apply(
        editor
            .toggle_format(Revision(5), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(view.text, format!("<{uri}> <{uri}>"));
    assert_eq!(editor.source_text(), format!("<`{uri}`> <`{uri}`>"));
    let action = OwnActionRelink {
        mappings: vec![("Old".into(), "New".into())],
        note_ids: vec!["Old".into()],
    };
    view.apply(
        editor
            .apply_own_relink(Revision(6), &action, &mut |_| Ok(()))
            .expect("equal URI text never merges distinct owned lifetimes")
            .unwrap(),
    );
    assert_eq!(editor.source_text(), format!("<`{next}`> <`{next}`>"));
    assert!(editor
        .project(Revision(7), range(0, 59))
        .unwrap()
        .links
        .is_empty());
    editor.select(Revision(7), range(1, 28)).unwrap();
    view.apply(
        editor
            .toggle_format(Revision(7), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    view.apply(
        editor
            .replace(Revision(8), range(29, 29), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, format!("<{next}>  <{next}>"));
    let first = editor
        .inspect_link(Revision(9), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(first.range, range(1, 28));
    assert_eq!(first.destination, next);
    assert!(editor
        .inspect_link(Revision(9), range(32, 33))
        .unwrap()
        .is_none());
    let opaque = editor.project(Revision(9), range(0, 60)).unwrap();
    assert_eq!(
        opaque
            .runs
            .iter()
            .filter(|run| run.formats.contains(&InlineFormat::Code))
            .map(|run| run.range)
            .collect::<Vec<_>>(),
        vec![range(32, 59)]
    );
    editor.select(Revision(9), range(32, 59)).unwrap();
    view.apply(
        editor
            .toggle_format(Revision(9), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    view.apply(
        editor
            .replace(Revision(10), range(60, 60), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        editor
            .inspect_link(Revision(11), range(32, 33))
            .unwrap()
            .unwrap()
            .destination,
        next
    );
    assert_eq!(
        editor
            .project(Revision(11), range(0, 61))
            .unwrap()
            .links
            .len(),
        2
    );
}
