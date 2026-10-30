use super::*;
use futo_notes_editor::{DisplayOffset, DisplayRange, Revision};

mod block_input;
mod blocks;
mod composition;
mod durability;
mod lifecycle;
mod lifecycle_crashes;
mod lifecycle_faults;
mod native_input_traces;
mod paragraphs;
mod portable;
mod portable_attachment;
mod portable_readiness;
mod recovery;
mod seams;
mod selected_source;
mod storage;

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn unchanged_editor_open_close_creates_no_recovery_or_note_write() {
    let root = TestRoot::new();
    let observer = Arc::new(RecordingObserver::default());
    let store = LocalNoteStore::with_before_write(root.0.clone(), observer.clone());
    store.create("", "plain", "  first\r\nlast\t ").unwrap();
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
fn accepted_edits_recover_and_checkpoint_returns_the_complete_store_mutation() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "one\r\ntwo  ").unwrap();
    {
        let mut editor = store.open_editor("plain").unwrap();
        let change = editor.replace(Revision(0), range(5, 8), "three").unwrap();
        assert_eq!(change.revision, Revision(1));
        assert_eq!(editor.source_text(), "one\r\nthree  ");
        assert_eq!(store.read("plain").unwrap(), "one\r\ntwo  ");
    }
    let mut recovered = store.open_editor("plain").unwrap();
    assert_eq!(recovered.source_text(), "one\r\nthree  ");
    assert_eq!(recovered.revision(), Revision(1));
    let result = recovered.checkpoint().unwrap();
    assert_eq!(result.disposition, FlushDisposition::Wrote);
    let mutation = result.mutation.unwrap();
    assert_eq!(mutation.final_id.as_deref(), Some("plain"));
    assert_eq!(mutation.upserted[0].note.id, "plain");
    assert_eq!(store.read("plain").unwrap(), "one\r\nthree  ");
    drop(recovered);
    let reopened = store.open_editor("plain").unwrap();
    assert_eq!(reopened.source_text(), "one\r\nthree  ");
    assert_eq!(reopened.revision(), Revision(0));
    assert_eq!(store.snapshot().notes.len(), 1);
}

#[test]
fn process_death_before_or_after_append_never_loses_a_completed_edit() {
    for (phase, expected, revision) in [("before", "plain!", 1), ("after", "plain!?", 2)] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "plain", "plain").unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::editor_session::process_death_child",
                "--nocapture",
            ])
            .env("FUTO_EDITOR_DEATH_VAULT", &root.0)
            .env("FUTO_EDITOR_DEATH_PHASE", phase)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(73));
        let recovered = store.open_editor("plain").unwrap();
        assert_eq!(recovered.source_text(), expected);
        assert_eq!(recovered.revision(), Revision(revision));
        assert_eq!(store.read("plain").unwrap(), "plain");
    }
}

#[test]
fn process_death_child() {
    let Some(root) = std::env::var_os("FUTO_EDITOR_DEATH_VAULT") else {
        return;
    };
    let phase = std::env::var("FUTO_EDITOR_DEATH_PHASE").unwrap();
    let store = LocalNoteStore::new(root.into());
    let mut editor = store.open_editor("plain").unwrap();
    let completed = editor.replace(Revision(0), range(5, 5), "!").unwrap();
    assert_eq!(completed.revision, Revision(1));
    editor.set_append_hook(Box::new(move |after| {
        if after == (phase == "after") {
            std::process::exit(73);
        }
    }));
    editor.replace(Revision(1), range(6, 6), "?").unwrap();
    panic!("process death was not injected");
}

#[test]
fn checkpoint_reports_a_committed_mutation_when_recovery_retirement_fails() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    editor.set_retirement_failure(true);
    let EditorStoreError::CheckpointCommitted { result, .. } = editor.checkpoint().unwrap_err()
    else {
        panic!("committed outcome must remain available to the shell");
    };
    assert_eq!(result.disposition, FlushDisposition::Wrote);
    assert_eq!(result.mutation.unwrap().final_id.as_deref(), Some("plain"));
    assert_eq!(store.read("plain").unwrap(), "plain!");
    assert!(matches!(
        editor.replace(Revision(1), range(6, 6), "?"),
        Err(EditorStoreError::CheckpointPending)
    ));
    editor.set_retirement_failure(false);
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    editor.replace(Revision(1), range(6, 6), "?").unwrap();
    drop(editor);
    let mut reopened = store.open_editor("plain").unwrap();
    assert_eq!(reopened.source_text(), "plain!?");
    assert_eq!(
        reopened.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
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
    assert_eq!(store.read("plain").unwrap(), "peer");
    assert_eq!(store.read(&parked_id).unwrap(), "plain!?");
}

#[test]
fn store_history_edits_are_recoverable_too() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "a\r\n").unwrap();
    {
        let mut editor = store.open_editor("plain").unwrap();
        editor.replace(Revision(0), range(0, 1), "b").unwrap();
        editor.undo(Revision(1)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "a\r\n");
        editor.redo(Revision(2)).unwrap().unwrap();
    }
    let recovered = store.open_editor("plain").unwrap();
    assert_eq!(recovered.source_text(), "b\r\n");
    assert_eq!(recovered.revision(), Revision(3));
}

#[test]
fn recovered_editor_can_continue_editing_before_checkpoint() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    {
        let mut editor = store.open_editor("plain").unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
    }
    {
        let mut editor = store.open_editor("plain").unwrap();
        editor.replace(Revision(1), range(6, 6), "?").unwrap();
    }
    let mut editor = store.open_editor("plain").unwrap();
    assert_eq!(editor.source_text(), "plain!?");
    assert_eq!(editor.revision(), Revision(2));
    editor.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "plain!?");
}

#[test]
fn two_store_instances_cannot_open_the_same_editor_recovery_stream() {
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
fn owned_editor_outlives_its_opening_store_handle_and_keeps_recovery() {
    let root = TestRoot::new();
    let opening_store = Arc::new(store(&root));
    opening_store.create("", "plain", "hello").unwrap();
    let mut editor = opening_store.open_owned_editor("plain").unwrap();
    drop(opening_store);
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    assert_eq!(editor.source_text(), "hello!");
    drop(editor);
    let store = store(&root);
    let mut recovered = store.open_editor("plain").unwrap();
    assert_eq!(recovered.source_text(), "hello!");
    recovered.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "hello!");
}

#[test]
fn hidden_inline_edits_history_recovery_and_checkpoint_preserve_exact_markdown() {
    use futo_notes_editor::{Affinity, InlineFormat};
    let root = TestRoot::new();
    let store = store(&root);
    let original = "__日😀__*ab* tail\t\r\n";
    store.create("", "inline", original).unwrap();
    {
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
    }
    let mut editor = store.open_editor("inline").unwrap();
    assert_eq!(editor.source_text(), "__日😀__*中*~~*ab*~~ tail\t\r\n");
    assert_eq!(editor.display_text(), "日😀中ab tail\t\r\n");
    assert_eq!(editor.revision(), Revision(4));
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
fn grouped_typing_uses_store_clock_and_recovery_replays_without_persistent_history() {
    use futo_notes_editor::DisplayReplacement;
    #[derive(Default)]
    struct Clock(std::sync::atomic::AtomicU64);
    impl RecoveryClock for Clock {
        fn now(&self) -> Duration {
            Duration::from_millis(self.0.load(std::sync::atomic::Ordering::Relaxed))
        }
    }
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "history", "__日__\r\n").unwrap();
    let clock = Arc::new(Clock::default());
    let mut editor = store
        .open_editor_with_recovery(
            "history",
            RecoveryOptions {
                clock: clock.clone(),
                ..RecoveryOptions::default()
            },
        )
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
    drop(editor);
    let mut recovered = store.open_editor("history").unwrap();
    assert_eq!(recovered.source_text(), "__中ax__\r\n");
    assert_eq!(recovered.revision(), Revision(7));
    assert!(recovered.undo(Revision(7)).unwrap().is_none());
    recovered.checkpoint().unwrap();
    assert_eq!(store.read("history").unwrap(), "__中ax__\r\n");
}
