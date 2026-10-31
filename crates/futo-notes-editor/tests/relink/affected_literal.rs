//! URI-class retirement reconciles the actual Guard and pending-Link history.
use super::*;

#[test]
fn a_valid_rename_can_make_a_live_code_word_literal_without_a_complete_uri() {
    let uri = "https://x.test/[[Old]]/path";
    let next = "https://x.test/[[New Name]]/path";
    let standard = EditorSession::open(&format!("<`{next}`>"));
    let expected_text = format!("<{next}>");
    assert_eq!(standard.display_text(), expected_text);
    let canonical = standard
        .project(Revision(0), range(0, expected_text.len()))
        .unwrap();
    assert!(canonical.links.is_empty());
    assert_eq!(
        canonical
            .runs
            .iter()
            .filter(|run| run.formats.contains(&InlineFormat::Code))
            .map(|run| run.range)
            .collect::<Vec<_>>(),
        vec![range(1, next.len() + 1)]
    );
    let mut editor = EditorSession::open("");
    editor
        .replace(
            Revision(0),
            range(0, 0),
            &format!("<{uri}"),
            &mut |_| Ok(()),
        )
        .unwrap();
    let end = uri.len() + 1;
    editor
        .replace(Revision(1), range(end, end), ">", &mut |_| Ok(()))
        .unwrap();
    editor.select(Revision(2), range(1, end)).unwrap();
    editor
        .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    let original = editor.source_text();
    assert_eq!(original, format!("<`{uri}`>"));
    // Capture the actual public pre-Code history source before deciding what
    // its former hidden autolink markers mean after the canonical rewrite.
    editor
        .undo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    let before_code = editor.source_text();
    assert_eq!(before_code, format!("<<{uri}>>"));
    editor
        .redo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), original);
    let historical = futo_notes_wikilinks::observe_wikilink_rewrite(
        &before_code,
        "Old",
        "New Name",
        &["Old".into()],
    );
    assert_eq!(historical.source, format!("<<{next}>>"));
    assert_eq!(
        EditorSession::open(&historical.source).display_text(),
        format!("<<{next}>>")
    );
    let literal_source = "\\<https\\://x.test/[[New Name]]/path\\>";
    let literal = EditorSession::open(literal_source);
    assert_eq!(literal.display_text(), expected_text);
    assert!(literal
        .project(Revision(0), range(0, expected_text.len()))
        .unwrap()
        .links
        .is_empty());
    let action = OwnActionRelink {
        mappings: vec![("Old".into(), "New Name".into())],
        note_ids: vec!["Old".into()],
    };
    // Retain a real future on Redo while the older pending-Link side remains
    // on Undo. Refusal must leave both available to the same later attempt.
    editor
        .replace_action(
            editor.revision(),
            range(end + 1, end + 1),
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
    let before = editor.project(revision, range(0, end + 1)).unwrap();
    let mut refused_calls = 0;
    let refused = editor.apply_own_relink(revision, &action, &mut |_| {
        refused_calls += 1;
        Err("injected literal retirement refusal".into())
    });
    assert!(matches!(refused, Err(EditorError::Persistence(_))));
    assert_eq!(refused_calls, 1);
    assert_eq!(editor.revision(), revision);
    assert_eq!(editor.source_text(), original);
    assert_eq!(editor.selection(), selection);
    assert_eq!(editor.affinity(), affinity);
    assert_eq!(editor.project(revision, range(0, end + 1)).unwrap(), before);
    let mut accepted = 0;
    editor
        .apply_own_relink(editor.revision(), &action, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap_or_else(|error| {
            panic!("valid changed Code text must accept; accepted={accepted}; error={error:?}")
        })
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(editor.source_text(), format!("<`{next}`>"));
    assert_eq!(editor.display_text(), expected_text);
    let actual = editor
        .project(editor.revision(), range(0, expected_text.len()))
        .unwrap();
    assert_eq!(actual.links, canonical.links);
    assert_eq!(actual.runs, canonical.runs);
    editor
        .redo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), format!("<`{next}`>!"));
    assert_eq!(editor.display_text(), format!("{expected_text}!"));
    editor
        .undo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), format!("<`{next}`>"));
    editor
        .undo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.display_text(), expected_text);
    let retired = editor
        .project(editor.revision(), range(0, expected_text.len()))
        .unwrap();
    assert!(retired.links.is_empty());
    assert!(retired
        .runs
        .iter()
        .all(|run| !run.formats.contains(&InlineFormat::Code)));
    let historical_fresh = EditorSession::open(&editor.source_text());
    assert_eq!(historical_fresh.display_text(), expected_text);
    assert!(historical_fresh
        .project(Revision(0), range(0, expected_text.len()))
        .unwrap()
        .links
        .is_empty());
    editor
        .redo(editor.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), format!("<`{next}`>"));
    let mut fresh = EditorSession::open(&editor.source_text());
    assert_eq!(fresh.display_text(), editor.display_text());
    assert!(fresh
        .project(Revision(0), range(0, expected_text.len()))
        .unwrap()
        .links
        .is_empty());
    for target in [&mut editor, &mut fresh] {
        target
            .select(target.revision(), range(1, next.len() + 1))
            .unwrap();
        target
            .toggle_format(target.revision(), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        target
            .replace(
                target.revision(),
                range(expected_text.len(), expected_text.len()),
                " ",
                &mut |_| Ok(()),
            )
            .unwrap();
        assert_eq!(target.display_text(), format!("{expected_text} "));
        assert!(target
            .project(target.revision(), range(0, expected_text.len() + 1))
            .unwrap()
            .links
            .is_empty());
    }
    assert_eq!(editor.source_text(), fresh.source_text());
}

#[test]
fn a_valid_rename_can_retire_the_uri_around_a_retained_partial_code_span() {
    let old = "https://x.test/[[Old]]/path";
    let new = "https://x.test/[[New Name]]/path";
    let candidate = r"<https\://x.test/`[[New Name]]`/path>";
    let standard = EditorSession::open(candidate);
    let shown = format!("<{new}>");
    assert_eq!(standard.display_text(), shown);
    let expected = standard
        .project(Revision(0), range(0, shown.len()))
        .unwrap();
    assert!(expected.links.is_empty());
    assert_eq!(
        expected
            .runs
            .iter()
            .filter(|run| run.formats.contains(&InlineFormat::Code))
            .map(|run| run.range)
            .collect::<Vec<_>>(),
        vec![range(16, 28)]
    );
    let mut editor = EditorSession::open("");
    editor
        .replace(
            Revision(0),
            range(0, 0),
            &format!("<{old}"),
            &mut |_| Ok(()),
        )
        .unwrap();
    let end = old.len() + 1;
    editor
        .replace(Revision(1), range(end, end), ">", &mut |_| Ok(()))
        .unwrap();
    editor.select(Revision(2), range(16, 23)).unwrap();
    editor
        .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), r"<https\://x.test/`[[Old]]`/path>");
    let action = OwnActionRelink {
        mappings: vec![("Old".into(), "New Name".into())],
        note_ids: vec!["Old".into()],
    };
    let mut accepted = 0;
    editor.apply_own_relink(Revision(3), &action, &mut |_| { accepted += 1; Ok(()) })
        .unwrap_or_else(|error| panic!("representable partial Code URI retirement must accept; accepted={accepted}; error={error:?}")).unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(editor.source_text(), candidate);
    assert_eq!(editor.display_text(), shown);
    let actual = editor
        .project(editor.revision(), range(0, shown.len()))
        .unwrap();
    assert_eq!(actual.runs, expected.runs);
    assert_eq!(actual.links, expected.links);
}
