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
    assert_eq!(store.read("plain").unwrap(), "abbbb");
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
    assert_eq!(store.read("plain").unwrap(), "xy");
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
    assert_eq!(store.read("plain").unwrap(), "base");
    let result = editor.close().unwrap();
    assert_eq!(result.disposition, FlushDisposition::Wrote);
    assert_eq!(store.read("plain").unwrap(), "base!");
    // The note can be attached again once the session closed.
    assert_eq!(store.open_editor("plain").unwrap().source_text(), "base!");
}

#[test]
fn a_native_draft_survives_a_vanished_parent_at_a_collision_safe_root_id() {
    for moved in [false, true] {
        let root = TestRoot::new();
        let outside = TestRoot::new();
        let store = store(&root);
        store.create("FolderF", "Fnote", "base").unwrap();
        store.create("", "Fnote (recovered)", "keep me").unwrap();
        let mut editor = store.open_editor("FolderF/Fnote").unwrap();
        editor.replace(Revision(0), range(4, 4), " before").unwrap();
        editor.checkpoint().unwrap();
        if moved {
            fs::rename(root.0.join("FolderF"), outside.0.join("FolderF")).unwrap();
        } else {
            fs::remove_file(root.0.join("FolderF/Fnote.md")).unwrap();
            fs::remove_dir(root.0.join("FolderF")).unwrap();
        }
        editor
            .replace(Revision(1), range(11, 11), " after")
            .unwrap();
        let saved = editor.checkpoint().expect("the draft must become durable");
        let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
            panic!("a vanished folder needs a visible recovery copy");
        };
        assert_eq!(parked_id, "Fnote (recovered)-2");
        assert_eq!(editor.id(), parked_id);
        let mutation = saved.mutation.unwrap();
        assert_eq!(mutation.removed, ["FolderF/Fnote"]);
        assert_eq!(mutation.final_id.as_deref(), Some(parked_id.as_str()));
        assert_eq!(mutation.upserted[0].note.id, parked_id);
        assert_eq!(store.read("Fnote (recovered)").unwrap(), "keep me");
        editor.replace(Revision(2), range(17, 17), "!").unwrap();
        editor.close().unwrap();
        drop(editor);
        drop(store);
        let reopened = LocalNoteStore::new(root.0.clone());
        assert_eq!(reopened.read(&parked_id).unwrap(), "base before after!");
        assert!(reopened
            .snapshot()
            .notes
            .iter()
            .any(|note| note.id == parked_id));
        assert!(!root.0.join("FolderF").exists());
        if moved {
            assert_eq!(
                fs::read_to_string(outside.0.join("FolderF/Fnote.md")).unwrap(),
                "base before"
            );
        }
    }
}

#[test]
fn a_native_close_recovers_when_the_parent_vanishes_inside_the_write_window() {
    let root = TestRoot::new();
    let outside = TestRoot::new();
    let store = store(&root);
    store.create("FolderF", "Fnote", "base").unwrap();
    let mut editor = store.open_editor("FolderF/Fnote").unwrap();
    editor.replace(Revision(0), range(4, 4), " after").unwrap();
    let from = root.0.join("FolderF");
    let to = outside.0.join("FolderF");
    *store.flush_window_hook.lock().unwrap() = Some(Box::new(move |_| {
        fs::rename(&from, &to).unwrap();
    }));
    let saved = editor
        .close()
        .expect("Back must preserve the draft on disk");
    assert_eq!(
        saved.mutation.unwrap().final_id.as_deref(),
        Some("Fnote (recovered)")
    );
    assert_eq!(store.read("Fnote (recovered)").unwrap(), "base after");
    assert!(!root.0.join("FolderF").exists());
}

#[test]
fn a_native_recovery_keeps_local_source_when_a_merged_write_loses_its_parent() {
    let root = TestRoot::new();
    let outside = TestRoot::new();
    let store = store(&root);
    store.create("FolderF", "Fnote", "one\ntwo\n").unwrap();
    let mut editor = store.open_editor("FolderF/Fnote").unwrap();
    editor.replace(Revision(0), range(4, 7), "local").unwrap();
    fs::write(root.0.join("FolderF/Fnote.md"), "peer\ntwo\n").unwrap();
    let from = root.0.join("FolderF");
    let to = outside.0.join("FolderF");
    *store.flush_window_hook.lock().unwrap() = Some(Box::new(move |_| {
        fs::rename(&from, &to).unwrap();
    }));
    editor.checkpoint().unwrap();
    assert_eq!(editor.source_text(), "one\nlocal\n");
    assert_eq!(store.read(&editor.id()).unwrap(), editor.source_text());
    assert_eq!(
        fs::read_to_string(outside.0.join("FolderF/Fnote.md")).unwrap(),
        "peer\ntwo\n"
    );
    // Recovery did not adopt an uncommitted merge or leave the old baseline dirty.
    assert_eq!(editor.save_delay(), None);
    assert!(editor.checkpoint().unwrap().mutation.is_none());
}

#[test]
fn a_dropped_session_loses_its_unsaved_edits_like_a_crash() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "base").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(4, 4), "!").unwrap();
    drop(editor);
    assert_eq!(store.read("plain").unwrap(), "base");
    assert_eq!(store.open_editor("plain").unwrap().source_text(), "base");
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
    assert_eq!(editor.source_text(), "base!?");
    std::fs::remove_dir(root.0.join("plain.md")).unwrap();
    assert_eq!(
        editor.close().unwrap().disposition,
        FlushDisposition::Recreated
    );
    assert_eq!(store.read("plain").unwrap(), "base!?");
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
    assert_eq!(store.read("plain").unwrap(), "peer");
    assert_eq!(store.read(&parked_id).unwrap(), "base!");
    // The session follows the parked note.
    assert_eq!(editor.id(), parked_id);
    editor.replace(Revision(1), range(5, 5), "?").unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(store.read(&parked_id).unwrap(), "base!?");
    assert_eq!(store.read("plain").unwrap(), "peer");
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
    assert_eq!(editor.source_text(), "base!");
    assert_eq!(store.read("new").unwrap(), "base");
    editor.checkpoint().unwrap();
    assert_eq!(store.read("new").unwrap(), "base!");
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
    assert_eq!(editor.source_text(), "[[long name]] tail");
    assert_eq!(editor.take_coordinated_changes().unwrap().len(), 1);
    // Adopting the rewrite left the draft equal to the file: nothing to save.
    assert!(editor.save_delay().is_none());
    assert_eq!(editor.checkpoint().unwrap().mutation, None);
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[old]] tail");
    assert!(editor.undo(editor.revision()).unwrap().is_none());
}

#[test]
fn a_note_is_saved_exactly_as_typed() {
    // Decision 17B: the file holds what was typed, no final line ending added.
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "typed", "").unwrap();
    let mut editor = store.open_editor("typed").unwrap();
    editor.replace(Revision(0), range(0, 0), "abc").unwrap();
    assert!(editor.checkpoint().unwrap().mutation.is_some());
    assert_eq!(fs::read_to_string(root.0.join("typed.md")).unwrap(), "abc");
    drop(editor);
    assert_eq!(store.open_editor("typed").unwrap().source_text(), "abc");

    // Deleting a final empty line is saved, and the note reopens without it.
    plant_note(&root, "plain", "x\n");
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(1, 2), "").unwrap();
    assert_eq!(editor.source_text(), "x");
    assert!(editor.checkpoint().unwrap().mutation.is_some());
    assert_eq!(fs::read_to_string(root.0.join("plain.md")).unwrap(), "x");
    drop(editor);
    assert_eq!(store.open_editor("plain").unwrap().source_text(), "x");
    // The same through a host with its own baseline, and both ways.
    store.flush_draft_unattached("plain", "x", "x\n").unwrap();
    assert_eq!(fs::read_to_string(root.0.join("plain.md")).unwrap(), "x\n");
    store.flush_draft_unattached("plain", "x\n", "x").unwrap();
    assert_eq!(fs::read_to_string(root.0.join("plain.md")).unwrap(), "x");

    // A line break typed at the end of a note with no final line ending.
    plant_note(&root, "list", "- a\nb");
    let mut editor = store.open_editor("list").unwrap();
    editor.replace(Revision(0), range(3, 3), "\n").unwrap();
    assert_eq!(editor.source_text(), "- a\nb\n");
    assert!(editor.checkpoint().unwrap().mutation.is_some());
    assert_eq!(
        fs::read_to_string(root.0.join("list.md")).unwrap(),
        "- a\nb\n"
    );
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
    assert_eq!(store.open_editor("plain").unwrap().source_text(), "fresh");
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
    assert_eq!(store.read("plain").unwrap(), "base!");
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
    assert_eq!(store.read("plain").unwrap(), "plain!?");
    assert_eq!(host.save_delay(), None);
    // Closing releases the note.
    host.close().unwrap();
    assert!(store.open_editor("plain").is_ok());
}
