use super::*;
use futo_notes_editor::{DisplayOffset, DisplayRange, Revision};

mod blocks;
mod clean_refresh;
mod clipboard;
mod composition;
mod external_rename;
mod images;
mod lifecycle;
mod links;
mod list_actions;
mod merging;
mod native_input_traces;
mod portable;
mod portable_attachment;
mod portable_waiting;
mod quick_open;
mod saving;
mod seams;
mod tables;
mod tags;
mod wikilinks;

/// A root note holding exactly `source`, which may lack the final line ending
/// every authored write appends (recovery.md): a peer's or an older note.
fn plant_note(root: &TestRoot, id: &str, source: &str) {
    fs::write(root.0.join(format!("{id}.md")), source).unwrap();
}

/// Source and display after an authored save of `source` (recovery.md): a
/// nonempty note without a final line ending gains its own (CRLF or LF). The
/// gained ending's display is the editor's own projection of the saved bytes.
fn saved_forms(source: &str, display: &str) -> (String, String) {
    if source.is_empty() || source.ends_with('\n') {
        return (source.to_owned(), display.to_owned());
    }
    let ending = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let saved = format!("{source}{ending}");
    let shown = futo_notes_editor::EditorSession::open(&saved).display_text();
    (saved, shown)
}

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn unchanged_editor_open_close_creates_no_note_write() {
    let root = TestRoot::new();
    let observer = Arc::new(RecordingObserver::default());
    let store = LocalNoteStore::with_before_write(root.0.clone(), observer.clone());
    plant_note(&root, "plain", "  first\r\nlast\t ");
    observer.0.lock().unwrap().clear();
    let before = store.snapshot();
    let editor = store.open_editor("plain").unwrap();
    assert_eq!(editor.source_text(), "  first\r\nlast\t ");
    drop(editor);
    assert_eq!(store.snapshot(), before);
    assert!(observer.0.lock().unwrap().is_empty());
    assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
}

#[test]
fn legacy_writes_are_refused_by_lease_under_any_case() {
    let root = TestRoot::new();
    let store = LocalNoteStore::new(root.0.clone());
    store.create("", "plain", "ab").unwrap();
    store.create("", "other", "x").unwrap();
    let editor = store.open_editor("plain").unwrap();
    let refused = [
        store.save_unattached(Some("PLAIN"), "PLAIN", "z", None),
        store.save_unattached(Some("other"), "Plain", "z", None),
        store.save_unattached(None, "plain", "z", None),
    ];
    for refusal in refused {
        assert!(refusal.unwrap_err().contains("editor_checkpoint"));
    }
    let refusal = store
        .flush_draft_unattached("Plain", "ab", "z")
        .unwrap_err();
    assert!(refusal.contains("editor_checkpoint"), "{refusal}");
    store
        .save_draft_as_unattached("other", "plain", "x", "z")
        .unwrap_err();
    assert_eq!(
        store.read_existing("plain").unwrap().as_deref(),
        Some("ab\n")
    );
    store
        .save_unattached(Some("other"), "other", "y", None)
        .unwrap();
    drop(editor);
    store.flush_draft_unattached("plain", "ab", "z").unwrap();
    assert_eq!(
        store.read_existing("plain").unwrap().as_deref(),
        Some("z\n")
    );
}

#[test]
fn checkpoint_returns_the_complete_store_mutation() {
    let root = TestRoot::new();
    let store = store(&root);
    plant_note(&root, "plain", "one\r\ntwo  ");
    let mut editor = store.open_editor("plain").unwrap();
    let change = editor.replace(Revision(0), range(5, 8), "three").unwrap();
    assert_eq!(change.revision, Revision(1));
    assert_eq!(editor.source_text(), "one\r\nthree  ");
    assert_eq!(store.read("plain").unwrap(), "one\r\ntwo  ");
    let result = editor.checkpoint().unwrap();
    assert_eq!(result.disposition, FlushDisposition::Wrote);
    let mutation = result.mutation.unwrap();
    assert_eq!(mutation.final_id.as_deref(), Some("plain"));
    assert_eq!(mutation.upserted[0].note.id, "plain");
    // The save appends the note's own CRLF ending.
    assert_eq!(store.read("plain").unwrap(), "one\r\nthree  \r\n");
    drop(editor);
    let reopened = store.open_editor("plain").unwrap();
    assert_eq!(reopened.source_text(), "one\r\nthree  \r\n");
    assert_eq!(reopened.revision(), Revision(0));
    assert_eq!(store.snapshot().notes.len(), 1);
}

#[test]
fn session_checkpoint_preserves_a_competing_note_and_follows_the_parked_id() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    store.write("plain", "peer", None).unwrap();
    let checkpoint = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = checkpoint.disposition else {
        panic!("draft must park");
    };
    assert_eq!(
        checkpoint.mutation.unwrap().final_id.as_deref(),
        Some(parked_id.as_str())
    );
    assert_eq!(editor.id(), parked_id);
    editor.replace(Revision(1), range(6, 6), "?").unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "peer\n");
    assert_eq!(store.read(&parked_id).unwrap(), "plain!?\n");
}

#[test]
fn history_edits_are_saved_like_any_other() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "a\r\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(0, 1), "b").unwrap();
    editor.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "a\r\n");
    editor.redo(Revision(2)).unwrap().unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "b\r\n");
}

#[test]
fn two_store_instances_cannot_attach_the_same_note() {
    let root = TestRoot::new();
    let first_store = store(&root);
    let second_store = store(&root);
    first_store.create("", "plain", "plain").unwrap();
    let first = first_store.open_editor("plain").unwrap();
    assert!(matches!(
        second_store.open_editor("plain"),
        Err(EditorStoreError::SessionAlreadyOpen)
    ));
    drop(first);
    assert!(second_store.open_editor("plain").is_ok());
}

#[test]
fn owned_editor_outlives_its_opening_store_handle() {
    let root = TestRoot::new();
    let opening_store = Arc::new(store(&root));
    opening_store.create("", "plain", "hello").unwrap();
    let mut editor = opening_store.open_owned_editor("plain").unwrap();
    drop(opening_store);
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    assert_eq!(editor.source_text(), "hello!\n");
    editor.close().unwrap();
    let store = store(&root);
    assert_eq!(store.read("plain").unwrap(), "hello!\n");
}

#[test]
fn hidden_inline_edits_history_and_checkpoint_preserve_exact_markdown() {
    use futo_notes_editor::{Affinity, InlineFormat};
    let root = TestRoot::new();
    let store = store(&root);
    let original = "__日😀__*ab* tail\t\r\n";
    store.create("", "inline", original).unwrap();
    let mut editor = {
        let mut editor = store.open_editor("inline").unwrap();
        assert_eq!(editor.display_text(), "日😀ab tail\t\r\n");
        editor
            .select_with_affinity(Revision(0), range(7, 7), Affinity::Forward)
            .unwrap();
        editor.replace(Revision(0), range(7, 7), "中").unwrap();
        assert_eq!(editor.source_text(), "__日😀__*中ab* tail\t\r\n");
        assert_eq!(editor.selection(), range(10, 10));
        editor
            .select_with_affinity(Revision(1), range(10, 12), Affinity::Forward)
            .unwrap();
        editor
            .toggle_format(Revision(1), InlineFormat::Strike)
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), "__日😀__*中*~~*ab*~~ tail\t\r\n");
        editor.undo(Revision(2)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "__日😀__*中ab* tail\t\r\n");
        editor.redo(Revision(3)).unwrap().unwrap();
        assert_eq!(editor.display_text(), "日😀中ab tail\t\r\n");
        assert_eq!(store.read("inline").unwrap(), original);
        assert_eq!(editor.source_text(), "__日😀__*中*~~*ab*~~ tail\t\r\n");
        assert_eq!(editor.revision(), Revision(4));
        editor
    };
    assert_eq!(
        editor.project(Revision(4), range(10, 12)).unwrap().runs[0].formats,
        vec![InlineFormat::Italic, InlineFormat::Strike]
    );
    editor.checkpoint().unwrap();
    assert_eq!(
        store.read("inline").unwrap(),
        "__日😀__*中*~~*ab*~~ tail\t\r\n"
    );
    drop(editor);
    let reopened = store.open_editor("inline").unwrap();
    assert_eq!(reopened.source_text(), "__日😀__*中*~~*ab*~~ tail\t\r\n");
    assert_eq!(reopened.display_text(), "日😀中ab tail\t\r\n");
}

#[test]
fn grouped_typing_uses_the_store_clock() {
    use futo_notes_editor::DisplayReplacement;
    #[derive(Default)]
    struct Clock(std::sync::atomic::AtomicU64);
    impl EditorClock for Clock {
        fn now(&self) -> Duration {
            Duration::from_millis(self.0.load(std::sync::atomic::Ordering::Relaxed))
        }
    }
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "history", "__日__\r\n").unwrap();
    let clock = Arc::new(Clock::default());
    let mut editor = store
        .open_editor_with_clock("history", clock.clone())
        .unwrap();
    editor.replace(Revision(0), range(3, 3), "a").unwrap();
    clock.0.store(499, std::sync::atomic::Ordering::Relaxed);
    editor.replace(Revision(1), range(4, 4), "b").unwrap();
    clock.0.store(999, std::sync::atomic::Ordering::Relaxed);
    editor.replace(Revision(2), range(5, 5), "c").unwrap();
    editor.undo(Revision(3)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "__日ab__\r\n");
    editor.undo(Revision(4)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "__日__\r\n");
    editor.redo(Revision(5)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "__日ab__\r\n");
    editor
        .replace_many(
            Revision(6),
            &[
                DisplayReplacement {
                    range: range(0, 3),
                    inserted: "中".into(),
                },
                DisplayReplacement {
                    range: range(4, 5),
                    inserted: "x".into(),
                },
            ],
        )
        .unwrap();
    assert_eq!(editor.source_text(), "__中ax__\r\n");
    editor.checkpoint().unwrap();
    assert_eq!(store.read("history").unwrap(), "__中ax__\r\n");
    drop(editor);
    let mut reopened = store.open_editor("history").unwrap();
    assert!(reopened.undo(Revision(0)).unwrap().is_none());
}
