//! Actual physical/opaque parents determine later reference meaning.
use super::*;
use futo_notes_editor::ParagraphKey;

#[test]
fn transformed_setext_body_keeps_its_repaired_meaning_for_the_next_reference_edit() {
    let original = "> head\n> pre&acE;fix\n> [id]: /target 'T'\n> ===\n\n[one][id]";
    let entered = "> head\n> pre&acE;fix\n> ===\n> \n> \\[id]: /target 'T'\n\n[one][id]";
    let changed = "> head\n> pre&acE;fix\n> ===\n> \n> \\[id]: /target 'T'\n\n[ONE][id]";
    let expected = "head\npre∾\u{333}fix\n\n[id]: /target 'T'\n\n[ONE][id]";
    let canonical = EditorSession::open(changed);
    assert_eq!(canonical.display_text(), expected);
    assert!(canonical
        .project(Revision(0), range(0, expected.len()))
        .unwrap()
        .links
        .is_empty());
    let mut editor = EditorSession::open(original);
    editor
        .paragraph_key(Revision(0), range(16, 16), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), entered);
    let one = editor.display_text().find("[one][id]").unwrap() + 1;
    editor
        .replace(Revision(1), range(one, one + 3), "ONE", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(editor.source_text(), changed);
    assert_eq!(editor.display_text(), expected);
    assert!(editor
        .project(Revision(2), range(0, expected.len()))
        .unwrap()
        .links
        .is_empty());
    for source in [entered, original] {
        editor
            .undo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), source);
    }
    for source in [entered, changed] {
        editor
            .redo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), source);
    }
    assert_eq!(editor.display_text(), canonical.display_text());
}

#[test]
fn an_outer_fence_keeps_a_locally_plausible_declaration_opaque_without_global_work() {
    let mut budgets = Vec::new();
    for count in [20, 20_000] {
        let tail = "unrelated body\n\n".repeat(count);
        let original = format!("```md\n[id]: /target extra\n```\n\n{tail}[one][id]");
        let changed = format!("```md\n[id]: /target \n```\n\n{tail}[one][id]");
        let canonical = EditorSession::open(&changed);
        assert!(canonical
            .project(Revision(0), range(0, canonical.display_text().len()))
            .unwrap()
            .links
            .is_empty());
        let mut editor = EditorSession::open(&original);
        let at = editor.display_text().find("extra").unwrap();
        let change = editor
            .replace(Revision(0), range(at, at + 5), "", &mut |_| Ok(()))
            .unwrap();
        assert_eq!(editor.source_text(), changed);
        assert_eq!(editor.display_text(), canonical.display_text());
        assert!(
            change.work.parsed_source_bytes < 500,
            "actual bounded parser work: {:?}",
            change.work
        );
        budgets.push((
            change.work.parsed_source_bytes,
            change.work.materialized_source_bytes,
            change.work.link_copied_bytes,
        ));
        let one = editor.display_text().rfind("[one][id]").unwrap() + 1;
        editor
            .replace(Revision(1), range(one, one + 3), "ONE", &mut |_| Ok(()))
            .unwrap();
        assert!(editor
            .inspect_link(Revision(2), range(one, one + 3))
            .unwrap()
            .is_none());
        assert!(editor.source_text().ends_with("[ONE][id]"));
    }
    assert_eq!(budgets[0], budgets[1]);
}
