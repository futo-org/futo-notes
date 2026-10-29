use super::*;
use futo_notes_editor::{DisplayOffset, DisplayRange, Revision};

mod durability;
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
