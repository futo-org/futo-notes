//! Own-action canonical relink preserves an unrelated live guard in every history generation.
use super::*;

#[test]
fn unrelated_own_relink_keeps_guarded_history_redo_and_refusal_atomic() {
    let mut editor = EditorSession::open("[[Old]] ");
    let mut view = common::ReferenceView::new("[[Old]] ");
    view.apply(
        editor
            .replace(
                Revision(0),
                range(8, 8),
                "<www.x.test/path",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(
        editor
            .replace(Revision(1), range(24, 24), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    editor.select(Revision(2), range(19, 24)).unwrap();
    view.apply(
        editor
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let guarded = editor.source_text();
    view.apply(
        editor
            .toggle_format(Revision(3), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let released = editor.source_text();
    view.apply(editor.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), guarded);
    assert_eq!(view.text, "[[Old]] <www.x.test/path>");
    editor
        .select_with_affinity(Revision(5), range(25, 25), Affinity::Forward)
        .unwrap();
    let before = editor.project(Revision(5), range(0, 25)).unwrap();
    assert!(before.links.is_empty());
    assert_eq!(
        before
            .runs
            .iter()
            .filter(|run| run.formats.contains(&InlineFormat::Code))
            .map(|run| run.range)
            .collect::<Vec<_>>(),
        vec![range(19, 24)]
    );

    // Independently prove the final canonical source while preserving every
    // byte outside this named wikilink. Fresh loading creates no live owner.
    let renamed_guard = guarded.replacen("[[Old]]", "[[New]]", 1);
    let renamed_release = released.replacen("[[Old]]", "[[New]]", 1);
    let candidate = EditorSession::open(&renamed_guard);
    assert_eq!(candidate.display_text(), "[[New]] <www.x.test/path>");
    let checked = candidate.project(Revision(0), range(0, 25)).unwrap();
    assert!(checked.links.is_empty());
    assert_eq!(
        checked
            .runs
            .iter()
            .filter(|run| run.formats.contains(&InlineFormat::Code))
            .map(|run| run.range)
            .collect::<Vec<_>>(),
        vec![range(19, 24)]
    );

    let noop = OwnActionRelink {
        mappings: vec![("Absent".into(), "Unused".into())],
        note_ids: vec!["Old".into()],
    };
    let mut calls = 0;
    assert!(editor
        .apply_own_relink(Revision(5), &noop, &mut |_| {
            calls += 1;
            Ok(())
        })
        .unwrap()
        .is_none());
    assert_eq!(calls, 0);
    assert_eq!(editor.revision(), Revision(5));
    assert_eq!(editor.source_text(), guarded);
    let action = OwnActionRelink {
        mappings: vec![("Old".into(), "New".into())],
        note_ids: vec!["Old".into()],
    };
    let refused = editor.apply_own_relink(Revision(5), &action, &mut |_| {
        calls += 1;
        Err("injected relink refusal".into())
    });
    assert!(matches!(refused, Err(EditorError::Persistence(_))), "an unrelated valid relink must reach the real acceptance boundary; got {refused:?}, calls={calls}");
    assert_eq!(calls, 1);
    assert_eq!(editor.source_text(), guarded);
    assert_eq!(editor.revision(), Revision(5));
    assert_eq!(editor.selection(), range(25, 25));
    assert_eq!(editor.project(Revision(5), range(0, 25)).unwrap(), before);

    view.apply(
        editor
            .apply_own_relink(Revision(5), &action, &mut |_| {
                calls += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(calls, 2);
    assert_eq!(editor.source_text(), renamed_guard);
    assert_eq!(editor.selection(), range(25, 25));
    assert_eq!(view.text, "[[New]] <www.x.test/path>");
    assert!(editor
        .project(Revision(6), range(0, 25))
        .unwrap()
        .links
        .is_empty());
    // This Redo existed before relink and before its refused first attempt.
    view.apply(editor.redo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), renamed_release);
    view.apply(editor.undo(Revision(7), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), renamed_guard);
    view.apply(editor.redo(Revision(8), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), renamed_release);
    editor.select(Revision(9), range(25, 25)).unwrap();
    view.apply(
        editor
            .replace(Revision(9), range(25, 25), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "[[New]] <www.x.test/path> ");
    let active = editor
        .inspect_link(Revision(10), range(9, 10))
        .unwrap()
        .unwrap();
    assert_eq!(active.range, range(9, 24));
    assert_eq!(active.destination, "http://www.x.test/path");
    view.apply(editor.undo(Revision(10), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), renamed_release);
    view.apply(editor.undo(Revision(11), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), renamed_guard);
    assert!(editor
        .project(Revision(12), range(0, 25))
        .unwrap()
        .links
        .is_empty());
}
