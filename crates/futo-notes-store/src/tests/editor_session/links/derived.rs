use super::*;

#[test]
fn literal_heading_definition_conversion_rejects_before_view_and_recovers_exact_retry() {
    use futo_notes_editor::{BlockCommand, DisplayUtf16Offset, DisplayUtf16Range};
    let native_range = DisplayUtf16Range {
        start: DisplayUtf16Offset(4),
        end: DisplayUtf16Offset(4),
    };
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        for (original, changed, shown, destination, selected_byte) in [
            (
                "# [id]: /target 'T'\n\n[one][id]\n\nbody",
                "\\[id]: /target 'T'\n\n[one][id]\n\nbody",
                "[id]: /target 'T'\n\n[one][id]\n\nbody",
                None,
                4,
            ),
            (
                "# [a&acE;]: /target 'T'\n\n[one][a&acE;]\n\n[a&acE;]: /first 'First'",
                "[a&acE;][a&acE;]: /target 'T'\n\n[one][a&acE;]\n\n[a&acE;]: /first 'First'",
                "a\u{223e}\u{333}: /target 'T'\n\none\n\n",
                Some("/first"),
                7,
            ),
        ] {
            let root = TestRoot::new();
            let store = store(&root);
            store.create("", "literal-heading", original).unwrap();
            let disk = Arc::new(Mutex::new(storage::Disk::default()));
            let mut editor = store
                .open_editor_with_recovery("literal-heading", storage::options(&disk))
                .unwrap();
            editor.select_utf16(Revision(0), native_range).unwrap();
            let before = editor.project(Revision(0), range(0, shown.len())).unwrap();
            disk.lock().unwrap().fault = Some(fault);
            assert!(matches!(
                editor.block_command_utf16(Revision(0), native_range, BlockCommand::Heading(0)),
                Err(EditorStoreError::RecoveryAppend(_))
            ));
            assert_eq!(editor.source_text(), original);
            assert_eq!(editor.display_text(), shown);
            assert_eq!(editor.selection(), range(selected_byte, selected_byte));
            assert_eq!(editor.revision(), Revision(0));
            assert_eq!(
                editor.project(Revision(0), range(0, shown.len())).unwrap(),
                before
            );
            assert_eq!(store.read("literal-heading").unwrap(), original);
            disk.lock().unwrap().fault = None;
            editor.resume_recovery().unwrap();
            editor
                .block_command_utf16(Revision(0), native_range, BlockCommand::Heading(0))
                .unwrap()
                .unwrap();
            assert_eq!(editor.source_text(), changed);
            assert_eq!(editor.display_text(), shown);
            assert_eq!(editor.selection(), range(selected_byte, selected_byte));
            editor.undo(Revision(1)).unwrap().unwrap();
            assert_eq!(editor.source_text(), original);
            editor.redo(Revision(2)).unwrap().unwrap();
            assert_eq!(editor.source_text(), changed);
            editor.flush_recovery().unwrap();
            drop(editor);
            let mut reopened = store
                .open_editor_with_recovery("literal-heading", storage::options(&disk))
                .unwrap();
            assert_eq!(reopened.source_text(), changed);
            assert_eq!(reopened.display_text(), shown);
            let at = shown.find("one").unwrap();
            let target = reopened
                .inspect_link(Revision(3), range(at, at + 1))
                .unwrap();
            assert_eq!(
                target.as_ref().map(|link| link.destination.as_str()),
                destination
            );
            if let Some(target) = target {
                assert_eq!(target.title.as_deref(), Some("First"));
            }
            reopened.checkpoint().unwrap();
            assert_eq!(store.read("literal-heading").unwrap(), changed);
        }
    }
}

#[test]
fn derived_reference_body_split_preserves_interior_atom_history_on_append_rejection() {
    use futo_notes_editor::{Affinity, DisplayUtf16Offset, DisplayUtf16Range, ParagraphKey};
    for (original, entered, opening, shown, native_caret, original_byte, entered_byte) in [
        (
            "# &acE;[id]: /target 'T'\n\n[one][id]",
            "# &acE;\n\\[id]: /target 'T'\n\n[one][id]",
            "\u{223e}\u{333}[id]: /target 'T'\n\n[one][id]",
            "\u{223e}\u{333}\n[id]: /target 'T'\n\n[one][id]",
            2,
            3,
            6,
        ),
        (
            "> head\n> pre&acE;fix\n> [id]: /target 'T'\n> ===\n\n[one][id]",
            "> head\n> pre&acE;fix\n> ===\n> \n> \\[id]: /target 'T'\n\n[one][id]",
            "head\npre\u{223e}\u{333}fix\n[id]: /target 'T'\n\n[one][id]",
            "head\npre\u{223e}\u{333}fix\n\n[id]: /target 'T'\n\n[one][id]",
            13,
            11,
            17,
        ),
    ] {
        let native = DisplayUtf16Range {
            start: DisplayUtf16Offset(native_caret),
            end: DisplayUtf16Offset(native_caret),
        };
        for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
            let root = TestRoot::new();
            let store = store(&root);
            store.create("", "split-reference", original).unwrap();
            let disk = Arc::new(Mutex::new(storage::Disk::default()));
            let mut editor = store
                .open_editor_with_recovery("split-reference", storage::options(&disk))
                .unwrap();
            editor
                .select_with_affinity(
                    Revision(0),
                    range(original_byte, original_byte),
                    Affinity::Backward,
                )
                .unwrap();
            let before = editor
                .project(Revision(0), range(0, opening.len()))
                .unwrap();
            disk.lock().unwrap().fault = Some(fault);
            assert!(matches!(
                editor.paragraph_key_utf16(Revision(0), native, ParagraphKey::Enter),
                Err(EditorStoreError::RecoveryAppend(_))
            ));
            assert_eq!(editor.source_text(), original);
            assert_eq!(editor.display_text(), opening);
            assert_eq!(editor.selection(), range(original_byte, original_byte));
            assert_eq!(
                editor
                    .project(Revision(0), range(0, opening.len()))
                    .unwrap(),
                before
            );
            assert_eq!(store.read("split-reference").unwrap(), original);
            disk.lock().unwrap().fault = None;
            editor.resume_recovery().unwrap();
            editor
                .paragraph_key_utf16(Revision(0), native, ParagraphKey::Enter)
                .unwrap()
                .unwrap();
            assert_eq!(editor.source_text(), entered);
            assert_eq!(editor.display_text(), shown);
            assert_eq!(editor.selection(), range(entered_byte, entered_byte));
            let restored = editor.undo(Revision(1)).unwrap().unwrap();
            assert_eq!(editor.source_text(), original);
            assert_eq!(editor.selection(), range(original_byte, original_byte));
            assert_eq!(restored.affinity, Affinity::Backward);
            editor.redo(Revision(2)).unwrap().unwrap();
            assert_eq!(editor.source_text(), entered);
            assert_eq!(editor.selection(), range(entered_byte, entered_byte));
            editor.flush_recovery().unwrap();
            drop(editor);
            let mut reopened = store
                .open_editor_with_recovery("split-reference", storage::options(&disk))
                .unwrap();
            assert_eq!(reopened.source_text(), entered);
            assert_eq!(reopened.display_text(), shown);
            assert!(reopened
                .project(Revision(3), range(0, shown.len()))
                .unwrap()
                .links
                .is_empty());
            reopened.checkpoint().unwrap();
            assert_eq!(store.read("split-reference").unwrap(), entered);
        }
    }
}

#[test]
fn live_url_word_end_split_preserves_pending_history_across_append_undo_redo_faults() {
    use futo_notes_editor::{Affinity, DisplayUtf16Offset, DisplayUtf16Range, ParagraphKey};
    let native = DisplayUtf16Range {
        start: DisplayUtf16Offset(22),
        end: DisplayUtf16Offset(22),
    };
    let initial = "# x&#32;";
    let pending = "# x&#32;\\*b https://x.test/a*";
    let committed = "# x&#32;*b https://x.test/a*\n";
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "live-url-split", initial).unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut editor = store
            .open_editor_with_recovery("live-url-split", storage::options(&disk))
            .unwrap();
        editor
            .replace(Revision(0), range(2, 2), "*b https://x.test/a*")
            .unwrap();
        editor
            .select_with_affinity(Revision(1), range(22, 22), Affinity::Backward)
            .unwrap();
        let before = editor.project(Revision(1), range(0, 22)).unwrap();
        let formats = editor.active_formats();
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.paragraph_key_utf16(Revision(1), native, ParagraphKey::Enter),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), pending);
        assert_eq!(editor.revision(), Revision(1));
        assert_eq!(editor.selection(), range(22, 22));
        assert_eq!(editor.active_formats(), formats);
        assert_eq!(editor.project(Revision(1), range(0, 22)).unwrap(), before);
        assert!(editor.composition().is_none());
        assert!(editor.recovery_status().paused);
        assert_eq!(store.read("live-url-split").unwrap(), initial);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor
            .paragraph_key_utf16(Revision(1), native, ParagraphKey::Enter)
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), committed);
        assert_eq!(editor.display_text(), "x b https://x.test/a\n");
        assert_eq!(editor.selection(), range(21, 21));
        assert_eq!(
            editor
                .inspect_link(Revision(2), range(4, 5))
                .unwrap()
                .unwrap()
                .destination,
            "https://x.test/a"
        );
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.undo(Revision(2)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), committed);
        assert_eq!(editor.selection(), range(21, 21));
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        let restored = editor.undo(Revision(2)).unwrap().unwrap();
        assert_eq!(editor.source_text(), pending);
        assert_eq!(editor.selection(), range(22, 22));
        assert_eq!(restored.affinity, Affinity::Backward);
        assert_eq!(editor.active_formats(), formats);
        assert!(editor
            .inspect_link(Revision(3), range(5, 6))
            .unwrap()
            .is_none());
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.redo(Revision(3)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), pending);
        assert!(editor
            .inspect_link(Revision(3), range(5, 6))
            .unwrap()
            .is_none());
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.redo(Revision(3)).unwrap().unwrap();
        assert_eq!(editor.source_text(), committed);
        editor.undo(Revision(4)).unwrap().unwrap();
        assert_eq!(editor.source_text(), pending);
        editor
            .paragraph_key_utf16(Revision(5), native, ParagraphKey::Enter)
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), committed);
        editor.undo(Revision(6)).unwrap().unwrap();
        assert_eq!(editor.source_text(), pending);
        editor.undo(Revision(7)).unwrap().unwrap();
        assert_eq!(editor.source_text(), initial);
        editor.redo(Revision(8)).unwrap().unwrap();
        assert_eq!(editor.source_text(), pending);
        editor.redo(Revision(9)).unwrap().unwrap();
        assert_eq!(editor.source_text(), committed);
        editor.flush_recovery().unwrap();
        drop(editor);
        let mut reopened = store
            .open_editor_with_recovery("live-url-split", storage::options(&disk))
            .unwrap();
        assert_eq!(reopened.source_text(), committed);
        assert_eq!(reopened.display_text(), "x b https://x.test/a\n");
        assert_eq!(
            reopened
                .inspect_link(Revision(10), range(4, 5))
                .unwrap()
                .unwrap()
                .destination,
            "https://x.test/a"
        );
        assert!(reopened.undo(Revision(10)).unwrap().is_none());
        reopened.checkpoint().unwrap();
        assert_eq!(store.read("live-url-split").unwrap(), committed);
    }
}
