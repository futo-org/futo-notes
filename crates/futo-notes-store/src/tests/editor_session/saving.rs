//! The debounced markdown save: 500 ms idle, 2 s max wait, no recovery log.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

struct TestClock(AtomicU64);
impl TestClock {
    fn new() -> Arc<Self> {
        Arc::new(Self(AtomicU64::new(0)))
    }
    fn advance(&self, millis: u64) {
        self.0.fetch_add(millis, Ordering::SeqCst);
    }
}
impl EditorClock for TestClock {
    fn now(&self) -> Duration {
        Duration::from_millis(self.0.load(Ordering::SeqCst))
    }
}

fn ms(millis: u64) -> Option<Duration> {
    Some(Duration::from_millis(millis))
}

#[test]
fn an_edit_is_due_after_500ms_and_continued_edits_are_saved_by_the_2s_max_wait() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "").unwrap();
    let clock = TestClock::new();
    let mut editor = store
        .open_editor_with_clock("plain", clock.clone())
        .unwrap();
    assert_eq!(editor.save_delay(), None);

    editor.replace(Revision(0), range(0, 0), "a").unwrap();
    assert_eq!(editor.save_delay(), ms(500));
    clock.advance(499);
    assert_eq!(editor.save_delay(), ms(1));
    assert!(editor.save_if_due().unwrap().is_none());
    assert_eq!(store.read("plain").unwrap(), "");

    // Typing every 400 ms keeps pushing the idle deadline out, never the max.
    let mut saved_at = None;
    for revision in 1..=10u64 {
        clock.advance(400);
        editor
            .replace(
                Revision(revision),
                range(revision as usize, revision as usize),
                "b",
            )
            .unwrap();
        if editor.save_if_due().unwrap().is_some() {
            saved_at = Some(clock.0.load(Ordering::SeqCst));
            break;
        }
    }
    // First edit at t=0: the max wait lands at 2000 ms, so the save happens on
    // the first edit at or after it (t = 499 + 400 * 4 = 2099).
    assert_eq!(saved_at, Some(2099));
    assert_eq!(store.read("plain").unwrap(), "abbbb\n");
    assert_eq!(editor.save_delay(), None);
}

#[test]
fn save_if_due_writes_the_markdown_and_clears_the_delay() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "x").unwrap();
    let clock = TestClock::new();
    let mut editor = store
        .open_editor_with_clock("plain", clock.clone())
        .unwrap();
    editor.replace(Revision(0), range(1, 1), "y").unwrap();
    let status = editor.save_status();
    assert_eq!(status.revision, Revision(1));
    assert_eq!(status.saved, Revision(0));
    assert_eq!(status.save_deadline, ms(500));
    clock.advance(500);
    assert_eq!(editor.save_delay(), Some(Duration::ZERO));
    let result = editor.save_if_due().unwrap().unwrap();
    assert_eq!(result.disposition, FlushDisposition::Wrote);
    assert_eq!(result.mutation.unwrap().final_id.as_deref(), Some("plain"));
    assert_eq!(store.read("plain").unwrap(), "xy\n");
    assert_eq!(editor.save_delay(), None);
    let status = editor.save_status();
    assert_eq!((status.revision, status.saved), (Revision(1), Revision(1)));
    assert_eq!(status.save_deadline, None);
    assert!(editor.save_if_due().unwrap().is_none());
}

#[test]
fn the_editor_leaves_no_hidden_state_in_the_vault() {
    let root = TestRoot::new();
    let store = store(&root);
    let clock = TestClock::new();
    store.create("", "plain", "base").unwrap();
    store.create("", "gone", "base").unwrap();
    // The vault root holds only the notes: no hidden recovery state appears.
    let absent = |why: &str| {
        let hidden: Vec<_> = std::fs::read_dir(&root.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with('.'))
            .collect();
        assert!(hidden.is_empty(), "{why}: {hidden:?}");
    };
    let mut editor = store
        .open_editor_with_clock("plain", clock.clone())
        .unwrap();
    absent("open");
    editor.replace(Revision(0), range(4, 4), "!").unwrap();
    absent("edit");
    clock.advance(500);
    editor.save_if_due().unwrap().unwrap();
    absent("save");
    editor.replace(Revision(1), range(5, 5), "?").unwrap();
    store.rename("plain", "renamed").unwrap();
    absent("rename");
    let mut other = store.open_editor("gone").unwrap();
    other.replace(Revision(0), range(4, 4), "!").unwrap();
    store.delete("gone").unwrap();
    absent("delete");
    editor.checkpoint().unwrap();
    absent("checkpoint");
    editor.close().unwrap();
    absent("close");
}

#[test]
fn close_saves_unsaved_edits() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "base").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(4, 4), "!").unwrap();
    assert_eq!(store.read("plain").unwrap(), "base\n");
    let result = editor.close().unwrap();
    assert_eq!(result.disposition, FlushDisposition::Wrote);
    assert_eq!(store.read("plain").unwrap(), "base!\n");
    // The note can be attached again once the session closed.
    assert_eq!(store.open_editor("plain").unwrap().source_text(), "base!\n");
}

#[test]
fn a_dropped_session_loses_its_unsaved_edits_like_a_crash() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "base").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(4, 4), "!").unwrap();
    drop(editor);
    assert_eq!(store.read("plain").unwrap(), "base\n");
    assert_eq!(store.open_editor("plain").unwrap().source_text(), "base\n");
}

#[test]
fn a_failed_save_keeps_the_session_attached_and_accepting_input() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "base").unwrap();
    let clock = TestClock::new();
    let mut editor = store
        .open_editor_with_clock("plain", clock.clone())
        .unwrap();
    editor.replace(Revision(0), range(4, 4), "!").unwrap();
    // A directory where the note's file should be makes every write fail.
    std::fs::remove_file(root.0.join("plain.md")).unwrap();
    std::fs::create_dir(root.0.join("plain.md")).unwrap();
    clock.advance(500);
    assert!(matches!(
        editor.save_if_due(),
        Err(EditorStoreError::Checkpoint(_))
    ));
    assert!(matches!(
        editor.close(),
        Err(EditorStoreError::Checkpoint(_))
    ));
    // The failure schedules a 2 s retry, so a host loop does not spin.
    assert_eq!(editor.save_delay(), ms(2000));
    // Still attached, still accepting input.
    assert!(matches!(
        store.open_editor("plain"),
        Err(EditorStoreError::SessionAlreadyOpen)
    ));
    editor.replace(Revision(1), range(5, 5), "?").unwrap();
    assert_eq!(editor.source_text(), "base!?\n");
    std::fs::remove_dir(root.0.join("plain.md")).unwrap();
    assert_eq!(
        editor.close().unwrap().disposition,
        FlushDisposition::Recreated
    );
    assert_eq!(store.read("plain").unwrap(), "base!?\n");
}

#[test]
fn an_outside_write_while_dirty_parks_a_conflict_copy_and_leaves_the_disk_version() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "base").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(4, 4), "!").unwrap();
    store.write("plain", "peer", None).unwrap();
    let result = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = result.disposition else {
        panic!("a draft over a peer's change must park");
    };
    assert_eq!(store.read("plain").unwrap(), "peer\n");
    assert_eq!(store.read(&parked_id).unwrap(), "base!\n");
    // The session follows the parked note.
    assert_eq!(editor.id(), parked_id);
    editor.replace(Revision(1), range(5, 5), "?").unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(store.read(&parked_id).unwrap(), "base!?\n");
    assert_eq!(store.read("plain").unwrap(), "peer\n");
}

#[test]
fn rename_while_dirty_keeps_the_draft_and_saves_under_the_new_id() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(4, 4), "!").unwrap();
    store.rename("old", "new").unwrap();
    assert_eq!(editor.id(), "new");
    assert_eq!(editor.source_text(), "base!\n");
    assert_eq!(store.read("new").unwrap(), "base\n");
    editor.checkpoint().unwrap();
    assert_eq!(store.read("new").unwrap(), "base!\n");
    assert_eq!(store.read_existing("old").unwrap(), None);
}

#[test]
fn rename_while_clean_adopts_the_rewritten_links_as_one_undo_step() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "[[old]] tail").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    store.rename("old", "long name").unwrap();
    assert_eq!(editor.id(), "long name");
    assert_eq!(editor.source_text(), "[[long name]] tail\n");
    assert_eq!(editor.take_coordinated_changes().unwrap().len(), 1);
    // Adopting the rewrite left the draft equal to the file: nothing to save.
    assert!(editor.save_delay().is_none());
    assert_eq!(editor.checkpoint().unwrap().mutation, None);
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[old]] tail\n");
    assert!(editor.undo(editor.revision()).unwrap().is_none());
}

#[test]
fn a_relink_after_a_save_keeps_the_drafts_missing_final_line_ending() {
    let root = TestRoot::new();
    let store = store(&root);
    plant_note(&root, "old", "[[old]]");
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(7, 7), "!").unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(store.read("old").unwrap(), "[[old]]!\n");
    store.rename("old", "long name").unwrap();
    // The saved ending is not an edit the user made: the draft keeps its own
    // spelling, while the file holds the rewritten saved bytes.
    assert_eq!(editor.source_text(), "[[long name]]!");
    assert_eq!(store.read("long name").unwrap(), "[[long name]]!\n");
    assert_eq!(editor.checkpoint().unwrap().mutation, None);
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[old]]!");
}

#[test]
fn a_draft_that_differs_from_the_disk_only_by_its_final_line_ending_is_written() {
    // A line break typed at the end of a note with no final line ending.
    let root = TestRoot::new();
    let store = store(&root);
    plant_note(&root, "list", "- a\nb");
    let mut editor = store.open_editor("list").unwrap();
    editor.replace(Revision(0), range(3, 3), "\n").unwrap();
    assert_eq!(editor.source_text(), "- a\nb\n");
    assert!(editor.checkpoint().unwrap().mutation.is_some());
    assert_eq!(
        fs::read_to_string(root.0.join("list.md")).unwrap(),
        "- a\nb\n"
    );
    drop(editor);
    let editor = store.open_editor("list").unwrap();
    assert_eq!(editor.source_text(), "- a\nb\n");
    drop(editor);
    // The same draft flushed by a host with its own baseline.
    plant_note(&root, "plain", "x");
    store.flush_draft_unattached("plain", "x", "x\n").unwrap();
    assert_eq!(fs::read_to_string(root.0.join("plain.md")).unwrap(), "x\n");
    // Removing a final line ending writes nothing: saving puts it back, and
    // the disk already holds those bytes.
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(1, 2), "").unwrap();
    assert_eq!(editor.source_text(), "x");
    assert_eq!(editor.checkpoint().unwrap().mutation, None);
    assert_eq!(fs::read_to_string(root.0.join("plain.md")).unwrap(), "x\n");
}

#[test]
fn deleting_an_attached_note_ends_the_session() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "base").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(4, 4), "!").unwrap();
    let removed = store.delete("plain").unwrap();
    assert_eq!(removed.removed, ["plain"]);
    assert_eq!(
        editor.replace(Revision(1), range(5, 5), "?"),
        Err(EditorStoreError::SessionDeleted)
    );
    assert!(matches!(
        editor.checkpoint(),
        Err(EditorStoreError::SessionDeleted)
    ));
    assert_eq!(store.read_existing("plain").unwrap(), None);
    // The draft is discarded and the id is free again.
    store.create("", "plain", "fresh").unwrap();
    assert_eq!(store.open_editor("plain").unwrap().source_text(), "fresh\n");
}

#[test]
fn deleting_an_already_removed_attached_note_still_ends_the_session() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "base").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(4, 4), "!").unwrap();
    std::fs::remove_file(root.0.join("plain.md")).unwrap();
    store.delete("plain").unwrap();
    assert!(matches!(
        editor.checkpoint(),
        Err(EditorStoreError::SessionDeleted)
    ));
    assert_eq!(store.read_existing("plain").unwrap(), None);
}

#[test]
fn a_failed_delete_leaves_the_session_alive() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "base").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    assert!(store
        .delete_with("plain", |_| Err("refused".into()))
        .is_err());
    editor.replace(Revision(0), range(4, 4), "!").unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "base!\n");
}

#[test]
fn the_portable_host_saves_through_the_same_schedule() {
    use futo_notes_editor::{PortableSession, SessionToken};
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let clock = TestClock::new();
    let mut host = store
        .open_editor_with_clock("plain", clock.clone())
        .unwrap()
        .into_portable_host(SessionToken(7))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let first = page.replace(Revision(0), range(5, 5), "!").unwrap();
    page.acknowledge(host.handle(first.request)).unwrap();
    assert_eq!(host.save_delay(), ms(500));
    clock.advance(400);
    let second = page.replace(Revision(1), range(6, 6), "?").unwrap();
    page.acknowledge(host.handle(second.request)).unwrap();
    // The first unsaved edit still owns the max wait; the second restarted idle.
    assert_eq!(host.save_delay(), ms(500));
    clock.advance(500);
    assert!(host.save_if_due().unwrap().is_some());
    assert_eq!(store.read("plain").unwrap(), "plain!?\n");
    assert_eq!(host.save_delay(), None);
    // Closing releases the note.
    host.close().unwrap();
    assert!(store.open_editor("plain").is_ok());
}
