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

#[test]
fn surrounding_rewrites_keep_the_equal_length_entity_atom_and_foreign_guard_exact() {
    let opening = "[[Old]] &acE;  [[Old]]";
    let mut editor = EditorSession::open(opening);
    let mut view = common::ReferenceView::new("[[Old]] \u{223e}\u{0333}  [[Old]]");
    view.apply(
        editor
            .replace(Revision(0), range(14, 14), "<www.x.test/path", &mut |_| {
                Ok(())
            })
            .unwrap(),
    );
    view.apply(
        editor
            .replace(Revision(1), range(30, 30), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    editor.select(Revision(2), range(25, 30)).unwrap();
    view.apply(
        editor
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(
        view.text,
        "[[Old]] \u{223e}\u{0333} <www.x.test/path> [[Old]]"
    );
    let guarded = editor.source_text();
    let renamed = guarded.replace("[[Old]]", "[[Long New]]");
    let candidate = EditorSession::open(&renamed);
    assert_eq!(
        candidate.display_text(),
        "[[Long New]] \u{223e}\u{0333} <www.x.test/path> [[Long New]]"
    );
    assert!(candidate
        .project(Revision(0), range(0, 49))
        .unwrap()
        .links
        .is_empty());
    editor
        .select_with_affinity(Revision(3), range(11, 11), Affinity::Backward)
        .unwrap();
    let action = OwnActionRelink {
        mappings: vec![("Old".into(), "Long New".into())],
        note_ids: vec!["Old".into()],
    };
    let mut calls = 0;
    let changed = editor
        .apply_own_relink(Revision(3), &action, &mut |_| {
            calls += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(calls, 1);
    assert_eq!(changed.selection, range(16, 16));
    assert_eq!(changed.affinity, Affinity::Backward);
    let target = changed.selection;
    view.apply(changed);
    assert_eq!(editor.source_text(), renamed);
    assert_eq!(view.text, candidate.display_text());
    // Consume the returned interior atom endpoint in a real subsequent action.
    view.apply(
        editor
            .replace_action(Revision(4), target, "!", InputAction::Isolated, &mut |_| {
                Ok(())
            })
            .unwrap(),
    );
    assert_eq!(
        view.text,
        "[[Long New]] \u{223e}!\u{0333} <www.x.test/path> [[Long New]]"
    );
    view.apply(editor.undo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), renamed);
    assert_eq!(editor.selection(), range(16, 16));
    editor.select(Revision(6), range(30, 35)).unwrap();
    view.apply(
        editor
            .toggle_format(Revision(6), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    editor.select(Revision(7), range(36, 36)).unwrap();
    view.apply(
        editor
            .replace(Revision(7), range(36, 36), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        view.text,
        "[[Long New]] \u{223e}\u{0333} <www.x.test/path>  [[Long New]]"
    );
    let active = editor
        .inspect_link(Revision(8), range(20, 21))
        .unwrap()
        .unwrap();
    assert_eq!(active.destination, "http://www.x.test/path");
    assert_eq!(active.range, range(20, 35));
}

fn shared_target_edge(old: &str, new: &str, at: usize, backward: usize, forward: usize) {
    for (affinity, expected) in [(Affinity::Backward, backward), (Affinity::Forward, forward)] {
        let opening = format!("x [[{old}]] y");
        let renamed = format!("x [[{new}]] y");
        assert_eq!(EditorSession::open(&renamed).display_text(), renamed);
        let mut editor = EditorSession::open(&opening);
        let mut view = common::ReferenceView::new(&opening);
        editor
            .select_with_affinity(Revision(0), range(at, at), affinity)
            .unwrap();
        let action = OwnActionRelink {
            mappings: vec![(old.into(), new.into())],
            note_ids: vec![old.into()],
        };
        let changed = editor
            .apply_own_relink(Revision(0), &action, &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(
            changed.selection,
            range(expected, expected),
            "{old:?} -> {new:?}, {affinity:?}"
        );
        let target = changed.selection;
        view.apply(changed);
        assert_eq!(editor.source_text(), renamed);
        view.apply(
            editor
                .replace_action(Revision(1), target, "!", InputAction::Isolated, &mut |_| {
                    Ok(())
                })
                .unwrap(),
        );
        let mut inserted = renamed.clone();
        inserted.insert(expected, '!');
        assert_eq!(view.text, inserted);
        view.apply(editor.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(editor.source_text(), renamed);
        assert_eq!(editor.selection(), range(expected, expected));
    }
}

#[test]
fn a_shared_target_prefix_keeps_the_original_end_boundary_affinity() {
    shared_target_edge("Roadmap", "Roadmap 2026", 11, 11, 16);
}

#[test]
fn a_shared_target_suffix_keeps_the_original_start_boundary_affinity() {
    shared_target_edge("plan", "New plan", 4, 4, 8);
}
