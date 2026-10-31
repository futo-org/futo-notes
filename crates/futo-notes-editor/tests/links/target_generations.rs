//! Actual OS runs consume every mapped endpoint before final caret consumption.
use super::*;
use futo_notes_editor::Affinity;

#[test]
fn nested_os_runs_consume_all_targets_across_remote_visibility_and_an_entity_atom() {
    for (definition_before, affinity) in [(true, Affinity::Backward), (false, Affinity::Forward)] {
        let original = if definition_before {
            "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n[one][id]\n\nteh &acE; wrod\n\ntail"
        } else {
            "preamble\n\nbuffer\n\n[one][id]\n\nteh &acE; wrod\n\ntail\n\n[id]: /target 'T'"
        };
        let marked_source = original.replace("[one][id]", "");
        let changed_source = marked_source.replace("teh &acE; wrod", "the ∾X word");
        let canonical = EditorSession::open(&changed_source);
        let expected_display = if definition_before {
            "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n\n\nthe ∾X word\n\ntail"
        } else {
            "preamble\n\nbuffer\n\n\n\nthe ∾X word\n\ntail\n\n[id]: /target 'T'"
        };
        assert_eq!(canonical.display_text(), expected_display);
        let mut editor = EditorSession::open(original);
        let initial_display = editor.display_text();
        let one = initial_display.find("one").unwrap();
        let body = initial_display.find("teh ").unwrap();
        let interior = body + "teh ∾".len();
        editor
            .select_with_affinity(Revision(0), range(interior, interior), affinity)
            .unwrap();
        editor
            .compose(Revision(0), range(one, one + 3), "")
            .unwrap();
        let mut provisional = initial_display.clone();
        provisional.replace_range(one..one + 3, "");
        let start = provisional.find("teh ").unwrap();
        let end = start + "teh ∾\u{333} wrod".len();
        let mut accepted = 0;
        let change = editor
            .replace_os(
                Revision(0),
                range(start, end),
                "the ∾X word",
                &[],
                &mut |_| {
                    accepted += 1;
                    Ok(())
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(accepted, 1);
        assert_eq!(editor.source_text(), changed_source);
        assert_eq!(editor.display_text(), expected_display);
        let caret = expected_display.find("the ∾X word").unwrap() + "the ∾X word".len();
        assert_eq!(change.selection, range(caret, caret));
        assert_eq!(editor.selection(), range(caret, caret));
        // The OS action internally consumed all run endpoints, including the
        // equal-byte-length nonidentity atom's interior. Consume its returned
        // authoritative endpoint again through an ordinary public edit.
        editor
            .replace(editor.revision(), change.selection, "!", &mut |_| Ok(()))
            .unwrap();
        assert_eq!(
            editor.source_text(),
            changed_source.replace("word", "word!")
        );
        editor
            .undo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), changed_source);
        editor
            .undo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), marked_source);
        editor
            .undo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), original);
        assert_eq!(editor.selection(), range(interior, interior));
        assert_eq!(editor.affinity(), affinity);
        for expected in [&marked_source, &changed_source] {
            editor
                .redo(editor.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(&editor.source_text(), expected);
        }
        assert_eq!(editor.selection(), range(caret, caret));
        assert_eq!(editor.display_text(), canonical.display_text());
    }
}
