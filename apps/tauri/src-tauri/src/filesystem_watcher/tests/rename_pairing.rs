//! Renames across backends, atomic saves, and the pair window.

use super::*;

/// macOS FSEvents carries no rename cookie: notify reports BOTH halves of a
/// rename as `Modify(Name(Any))`, one event per path (notify's fsevent.rs).
/// Reported as two edits, the shell flushed the open note's pending save to
/// the id it had just left, and the store recreated it there — a ghost that
/// synced everywhere, holding the typing the renamed note never got. The
/// half whose path is gone is the old name; the half that exists is the new.
#[test]
fn a_cookieless_rename_is_paired_by_which_path_still_exists() {
    let root = temp_vault("pair");
    std::fs::write(root.join("Draft renamed.md"), "draft").unwrap();
    std::fs::write(root.join("Saved.md"), "saved").unwrap();
    let (processor, recorder) = recording_processor(&root);

    processor.process(rename_half(RenameMode::Any, root.join("Draft.md")));
    // FSEvents coalesces flags per path, so an earlier write to the old name
    // can arrive after it is gone. A file that no longer exists has no edit.
    processor.process(
        Event::new(EventKind::Modify(ModifyKind::Data(
            notify::event::DataChange::Content,
        )))
        .add_path(root.join("Draft.md")),
    );
    processor.process(rename_half(RenameMode::Any, root.join("Draft renamed.md")));
    // A new name with no old half — the destination of an atomic save's
    // hidden temp file — stays what it was: an edit of that note.
    processor.process(rename_half(RenameMode::Any, root.join("Saved.md")));

    let seen = recorder.take();
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(
        seen,
        vec!["rename Draft.md -> Draft renamed.md", "change Saved.md"]
    );
}

/// Windows (ReadDirectoryChangesW) reports the old then the new name, also
/// without a cookie; the same arrival-order pairing makes it one rename
/// instead of a removal and an add.
#[test]
fn a_cookieless_old_then_new_name_is_one_rename() {
    let root = temp_vault("from-to");
    std::fs::write(root.join("Moved.md"), "moved").unwrap();
    let (processor, recorder) = recording_processor(&root);

    processor.process(rename_half(RenameMode::From, root.join("Note.md")));
    processor.process(rename_half(RenameMode::To, root.join("Moved.md")));

    let seen = recorder.take();
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(seen, vec!["rename Note.md -> Moved.md"]);
}

/// inotify hands the two halves of a rename a shared cookie, so the pair
/// is exact whatever happens to the old name next. A cloud client's
/// rename of a note to a conflict name that a sync then writes a new note
/// over (iCloud: "A" -> "A 2", new "A") leaves the old name occupied by
/// the time the halves are read; the rename is still a rename.
#[test]
fn a_cookie_paired_rename_is_exact_even_when_the_old_name_is_occupied_again() {
    let root = temp_vault("cookie");
    std::fs::write(root.join("A.md"), "new note").unwrap();
    std::fs::write(root.join("A 2.md"), "old note").unwrap();
    let (processor, recorder) = recording_processor(&root);

    processor.process(rename_half(RenameMode::From, root.join("A.md")).set_tracker(7));
    processor.process(rename_half(RenameMode::To, root.join("A 2.md")).set_tracker(7));

    let seen = recorder.take();
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(seen, vec!["rename A.md -> A 2.md"]);
}

/// An old name whose new half never comes (moved out of the vault — the
/// Trash is outside it) is a removal, reported once the pair window closes
/// even when no later event arrives to flush it.
#[test]
fn an_unpaired_old_name_is_reported_as_removed_after_the_pair_window() {
    let root = temp_vault("unpaired");
    let (processor, recorder) = recording_processor(&root);

    processor.process(rename_half(RenameMode::Any, root.join("Gone.md")));
    let before_window = recorder.take();
    let removed = recorder.wait_for("unlink Gone.md", std::time::Duration::from_secs(3));

    let seen = recorder.take();
    std::fs::remove_dir_all(&root).unwrap();
    assert!(
        before_window.is_empty(),
        "reported before its pair window closed: {before_window:?}"
    );
    assert!(removed, "never reported as removed; saw {seen:?}");
    assert_eq!(seen, vec!["unlink Gone.md"]);
}

/// A note path that a rename emptied and that is written again is an edit
/// of the note, whether the rewrite is reported (vim: backup rename, new
/// file) or only found by the recheck when the window closes. So is a
/// removal FSEvents left on a path that exists again.
#[test]
fn a_note_path_a_rename_emptied_is_an_edit_once_it_is_back() {
    let root = temp_vault("back");
    let (processor, recorder) = recording_processor(&root);

    processor.process(rename_half(RenameMode::Any, root.join("note.md")));
    processor.process(rename_half(RenameMode::Any, root.join("note.md~")));
    std::fs::write(root.join("note.md"), "rewritten").unwrap();
    processor.process(
        Event::new(EventKind::Create(notify::event::CreateKind::File))
            .add_path(root.join("note.md")),
    );
    processor.process(
        Event::new(EventKind::Remove(notify::event::RemoveKind::File))
            .add_path(root.join("note.md")),
    );
    let reported = recorder.take();

    processor.process(rename_half(RenameMode::Any, root.join("quiet.md")));
    std::fs::write(root.join("quiet.md"), "rewritten").unwrap();
    let rechecked = recorder.wait_for("change quiet.md", std::time::Duration::from_secs(3));
    std::thread::sleep(std::time::Duration::from_millis(
        RENAME_PAIR_TIMEOUT_MS as u64 + 200,
    ));
    let seen = recorder.take();
    std::fs::remove_dir_all(&root).unwrap();

    assert_eq!(reported, vec!["change note.md", "change note.md"]);
    assert!(rechecked, "never rechecked; saw {seen:?}");
    assert_eq!(seen, vec!["change quiet.md"]);
}
