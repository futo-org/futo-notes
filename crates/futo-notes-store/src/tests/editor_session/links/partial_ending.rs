//! Parser-owned partial URL endings remain atomic through actual recovery appends.
use super::*;

fn reject_then_retry(
    editor: &mut crate::StoreEditorSession<'_>,
    disk: &Arc<Mutex<storage::Disk>>,
    fault: storage::Fault,
    action: impl Fn(&mut crate::StoreEditorSession<'_>) -> Result<(), EditorStoreError>,
) {
    let revision = editor.revision();
    let source = editor.source_text();
    let display = editor.display_text();
    let selection = editor.selection();
    let formats = editor.active_formats();
    let before = editor.project(revision, range(0, display.len())).unwrap();
    disk.lock().unwrap().fault = Some(fault);
    assert!(matches!(
        action(editor),
        Err(EditorStoreError::RecoveryAppend(_))
    ));
    assert_eq!(editor.revision(), revision);
    assert_eq!(editor.source_text(), source);
    assert_eq!(editor.display_text(), display);
    assert_eq!(editor.selection(), selection);
    assert_eq!(editor.active_formats(), formats);
    assert_eq!(
        editor.project(revision, range(0, display.len())).unwrap(),
        before
    );
    assert!(editor.composition().is_none());
    disk.lock().unwrap().fault = None;
    editor.resume_recovery().unwrap();
    action(editor).unwrap();
}

#[test]
fn partial_url_endings_retry_closer_word_end_and_history_without_persisting_timing() {
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        for (input, closed, candidate, href, link_end) in [
            (
                "<https://x.test/a.",
                true,
                "<<https://x.test/a>.>",
                "https://x.test/a",
                17,
            ),
            (
                "<www.x.test/a.",
                true,
                "<[www.x.test/a](<http://www.x.test/a>).>",
                "http://www.x.test/a",
                13,
            ),
            (
                "<www.x.test/a.",
                false,
                "<[www.x.test/a](<http://www.x.test/a>).",
                "http://www.x.test/a",
                13,
            ),
        ] {
            // Independent standard source fixes the visible punctuation and href.
            let canonical = futo_notes_editor::EditorSession::open(candidate);
            let shown = format!("{input}{}", if closed { ">" } else { "" });
            assert_eq!(canonical.display_text(), shown);
            let expected = canonical
                .inspect_link(Revision(0), range(1, 2))
                .unwrap()
                .unwrap();
            assert_eq!(expected.range, range(1, link_end));
            assert_eq!(expected.destination, href);
            let root = TestRoot::new();
            let store = store(&root);
            store.create("", "partial-ending", "").unwrap();
            let disk = Arc::new(Mutex::new(storage::Disk::default()));
            let mut editor = store
                .open_editor_with_recovery("partial-ending", storage::options(&disk))
                .unwrap();
            editor.replace(Revision(0), range(0, 0), input).unwrap();
            assert!(editor
                .project(Revision(1), range(0, input.len()))
                .unwrap()
                .links
                .is_empty());
            if closed {
                editor
                    .select_with_affinity(
                        Revision(1),
                        range(0, 0),
                        futo_notes_editor::Affinity::Forward,
                    )
                    .unwrap();
                editor
                    .select_with_affinity(
                        Revision(1),
                        range(input.len(), input.len()),
                        futo_notes_editor::Affinity::Forward,
                    )
                    .unwrap();
                reject_then_retry(&mut editor, &disk, fault, |editor| {
                    editor
                        .replace(editor.revision(), range(input.len(), input.len()), ">")
                        .map(|_| ())
                });
                let saved = futo_notes_editor::EditorSession::open(&editor.source_text());
                assert_eq!(saved.display_text(), shown);
                assert_eq!(
                    saved
                        .inspect_link(Revision(0), range(1, 2))
                        .unwrap()
                        .unwrap(),
                    expected
                );
            }
            assert_eq!(editor.display_text(), shown);
            let pending_source = editor.source_text();
            let revision = editor.revision();
            assert!(editor
                .project(revision, range(0, shown.len()))
                .unwrap()
                .links
                .is_empty());
            editor
                .select_with_affinity(revision, range(0, 0), futo_notes_editor::Affinity::Forward)
                .unwrap();
            editor
                .select_with_affinity(
                    revision,
                    range(shown.len(), shown.len()),
                    futo_notes_editor::Affinity::Forward,
                )
                .unwrap();
            reject_then_retry(&mut editor, &disk, fault, |editor| {
                editor
                    .replace(editor.revision(), range(shown.len(), shown.len()), " ")
                    .map(|_| ())
            });
            let active_source = editor.source_text();
            assert_eq!(editor.display_text(), format!("{shown} "));
            assert_eq!(
                editor
                    .inspect_link(editor.revision(), range(1, 2))
                    .unwrap()
                    .unwrap(),
                expected
            );
            let saved = futo_notes_editor::EditorSession::open(&active_source);
            assert_eq!(saved.display_text(), format!("{shown} "));
            assert_eq!(
                saved
                    .inspect_link(Revision(0), range(1, 2))
                    .unwrap()
                    .unwrap(),
                expected
            );
            reject_then_retry(&mut editor, &disk, fault, |editor| {
                editor
                    .undo(editor.revision())
                    .map(|change| assert!(change.is_some()))
            });
            assert_eq!(editor.source_text(), pending_source);
            assert!(editor
                .project(editor.revision(), range(0, shown.len()))
                .unwrap()
                .links
                .is_empty());
            reject_then_retry(&mut editor, &disk, fault, |editor| {
                editor
                    .redo(editor.revision())
                    .map(|change| assert!(change.is_some()))
            });
            assert_eq!(editor.source_text(), active_source);
            assert_eq!(
                editor
                    .inspect_link(editor.revision(), range(1, 2))
                    .unwrap()
                    .unwrap(),
                expected
            );
            editor.undo(editor.revision()).unwrap().unwrap();
            assert_eq!(editor.source_text(), pending_source);
            editor.flush_recovery().unwrap();
            drop(editor);
            let mut recovered = store
                .open_editor_with_recovery("partial-ending", storage::options(&disk))
                .unwrap();
            assert_eq!(recovered.source_text(), pending_source);
            assert_eq!(recovered.display_text(), shown);
            // Recovery restores canonical source, never transient typed ownership.
            let loaded = recovered
                .inspect_link(recovered.revision(), range(1, 2))
                .unwrap();
            if closed {
                assert_eq!(loaded.unwrap(), expected);
            } else {
                assert!(loaded.is_none());
            }
            assert!(recovered.undo(recovered.revision()).unwrap().is_none());
            recovered.checkpoint().unwrap();
            assert_eq!(store.read("partial-ending").unwrap(), pending_source);
        }
    }
}
