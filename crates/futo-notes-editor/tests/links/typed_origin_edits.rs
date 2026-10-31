//! Ordinary user edits of a supplied typed origin are distinct from new typing seeds.
use super::*;
use futo_notes_editor::InputAction;

#[test]
fn isolated_path_correction_accepts_literal_source_and_undo_restores_typed_lifetime() {
    let original = "<www.x.test/path";
    let corrected = "<www.x.test/math";
    for source in [original, corrected] {
        let fresh = EditorSession::open(source);
        assert_eq!(fresh.display_text(), source);
        assert!(fresh
            .project(Revision(0), range(0, 16))
            .unwrap()
            .links
            .is_empty());
    }
    let mut editor = EditorSession::open("");
    let mut view = ReferenceView::new("");
    view.apply(
        editor
            .replace(Revision(0), range(0, 0), original, &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(editor.source_text(), original);
    assert!(editor
        .project(Revision(1), range(0, 16))
        .unwrap()
        .links
        .is_empty());
    editor.select(Revision(1), range(12, 13)).unwrap();
    let before = editor.source_text();
    let mut accepted = 0;
    let change = editor
        .replace_action(
            Revision(1),
            range(12, 13),
            "m",
            InputAction::Isolated,
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        )
        .expect(
            "a canonical literal ASCII correction inside a live typed word is a valid user edit",
        );
    assert_eq!(accepted, 1);
    view.apply(change);
    assert_eq!(editor.source_text(), corrected);
    assert_eq!(view.text, corrected);
    assert_eq!(editor.selection(), range(13, 13));
    let fresh = EditorSession::open(&editor.source_text());
    assert_eq!(fresh.display_text(), view.text);
    assert!(fresh
        .project(Revision(0), range(0, 16))
        .unwrap()
        .links
        .is_empty());
    view.apply(editor.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), before);
    assert_eq!(view.text, original);
    assert!(editor
        .project(Revision(3), range(0, 16))
        .unwrap()
        .links
        .is_empty());
    view.apply(editor.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), corrected);
    assert_eq!(view.text, corrected);
    view.apply(editor.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    editor.select(Revision(5), range(16, 16)).unwrap();
    view.apply(
        editor
            .replace(Revision(5), range(16, 16), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<www.x.test/path>");
    assert!(editor
        .project(Revision(6), range(0, 17))
        .unwrap()
        .links
        .is_empty());
    editor.select(Revision(6), range(0, 0)).unwrap();
    editor.select(Revision(6), range(17, 17)).unwrap();
    view.apply(
        editor
            .replace(Revision(6), range(17, 17), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    let link = editor
        .inspect_link(Revision(7), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(link.range, range(1, 16));
    assert_eq!(link.destination, "http://www.x.test/path");
    assert_eq!(view.text, "<www.x.test/path> ");
}

#[test]
fn syntax_bearing_isolated_correction_matches_the_established_loaded_word_action() {
    let original = "<www.x.test/path";
    let candidate = "<www.x.test/*ath";
    let canonical = EditorSession::open(candidate);
    assert_eq!(canonical.display_text(), candidate);
    assert!(canonical
        .project(Revision(0), range(0, 16))
        .unwrap()
        .links
        .is_empty());
    // This existing unowned action pins insertion intent independently of the
    // new retirement path; a single literal star is not an emphasis request.
    let mut loaded = EditorSession::open(original);
    let baseline = loaded
        .replace_action(
            Revision(0),
            range(12, 13),
            "*",
            InputAction::Isolated,
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(loaded.source_text(), candidate);
    assert_eq!(loaded.display_text(), candidate);
    let mut live = EditorSession::open("");
    live.replace(Revision(0), range(0, 0), original, &mut |_| Ok(()))
        .unwrap();
    let before = live.source_text();
    let changed = live
        .replace_action(
            Revision(1),
            range(12, 13),
            "*",
            InputAction::Isolated,
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(live.source_text(), loaded.source_text());
    assert_eq!(live.display_text(), loaded.display_text());
    assert_eq!(changed.selection, baseline.selection);
    assert_eq!(changed.projection.text, baseline.projection.text);
    assert_eq!(changed.projection.links, baseline.projection.links);
    assert_eq!(changed.projection.runs, baseline.projection.runs);
    live.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(live.source_text(), before);
    live.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(live.source_text(), candidate);
}

#[test]
fn equal_restoration_does_not_reenroll_a_retired_word_or_touch_its_identical_foreign_link() {
    let original = "<www.x.test/path";
    let prefix = "<[www.x.test/path](<http://www.x.test/path>)>\n\n";
    let visible_prefix = "<www.x.test/path>\n\n";
    let mut editor = EditorSession::open(prefix);
    assert_eq!(editor.display_text(), visible_prefix);
    let foreign = editor
        .inspect_link(Revision(0), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(foreign.destination, "http://www.x.test/path");
    let base = visible_prefix.len();
    editor
        .replace(Revision(0), range(base, base), original, &mut |_| Ok(()))
        .unwrap();
    editor
        .replace_action(
            Revision(1),
            range(base + 12, base + 13),
            "m",
            InputAction::Isolated,
            &mut |_| Ok(()),
        )
        .unwrap();
    editor
        .replace_action(
            Revision(2),
            range(base + 12, base + 13),
            "p",
            InputAction::Isolated,
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(editor.source_text(), format!("{prefix}{original}"));
    // Equal bytes on reopen have no typed identity. Use the actual established
    // closer/word-end behavior of that unowned source as the lifetime control.
    let mut loaded = EditorSession::open(&editor.source_text());
    let at = base + original.len();
    for (step, text) in [">", " "].into_iter().enumerate() {
        let revision = Revision(3 + step as u64);
        editor.select(revision, range(0, 0)).unwrap();
        editor
            .select(revision, range(at + step, at + step))
            .unwrap();
        loaded
            .select(Revision(step as u64), range(at + step, at + step))
            .unwrap();
        editor
            .replace(revision, range(at + step, at + step), text, &mut |_| Ok(()))
            .unwrap();
        loaded
            .replace(
                Revision(step as u64),
                range(at + step, at + step),
                text,
                &mut |_| Ok(()),
            )
            .unwrap();
        assert_eq!(editor.source_text(), loaded.source_text());
        assert_eq!(editor.display_text(), loaded.display_text());
        assert_eq!(
            editor
                .inspect_link(Revision(4 + step as u64), range(1, 2))
                .unwrap()
                .unwrap(),
            foreign
        );
        assert!(editor
            .inspect_link(Revision(4 + step as u64), range(base + 1, base + 2))
            .unwrap()
            .is_none());
    }
    assert!(editor.source_text().starts_with(prefix));
}
