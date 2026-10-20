//! The platform's own backend feeding a recording processor.

use super::*;

/// The platform's own backend (FSEvents on macOS, inotify on Linux,
/// ReadDirectoryChangesW on Windows) feeding a recording processor.
struct NativeWatch {
    _watcher: RecommendedWatcher,
    recorder: Recorder,
    raw: Arc<Mutex<Vec<String>>>,
}

impl NativeWatch {
    fn start(root: &Path) -> Self {
        // Let the vault's setup writes age out of the backend's coalescing window.
        std::thread::sleep(std::time::Duration::from_millis(1_000));
        let (processor, recorder) = recording_processor(root);
        let raw = Arc::new(Mutex::new(Vec::<String>::new()));
        let raw_log = raw.clone();
        let mut watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(event) = result {
                    raw_log.lock().unwrap().push(format!(
                        "{:?} {:?} {:?}",
                        event.kind,
                        event
                            .paths
                            .iter()
                            .filter_map(|p| p.file_name())
                            .collect::<Vec<_>>(),
                        event.attrs.tracker()
                    ));
                    processor.process(event);
                }
            },
            Config::default(),
        )
        .unwrap();
        watcher.watch(root, RecursiveMode::Recursive).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        recorder.take();
        raw.lock().unwrap().clear();
        Self {
            _watcher: watcher,
            recorder,
            raw,
        }
    }

    /// Everything reported once any pair window the actions opened has
    /// closed, and what the backend sent.
    fn settle(self) -> (Vec<String>, Vec<String>) {
        std::thread::sleep(std::time::Duration::from_millis(
            RENAME_PAIR_TIMEOUT_MS as u64 + 1_000,
        ));
        drop(self._watcher);
        let raw = self.raw.lock().unwrap().clone();
        (self.recorder.take(), raw)
    }
}

/// The platform's own backend reports a rename inside the vault as one
/// rename, never as an edit or a removal of either name (M26: this runs
/// on each desktop platform's real backend, not only on a synthetic shape).
#[test]
fn the_native_backend_reports_a_rename_as_one_rename() {
    let root = temp_vault("native");
    std::fs::write(root.join("Draft.md"), "draft").unwrap();
    let watch = NativeWatch::start(&root);

    std::fs::rename(root.join("Draft.md"), root.join("Draft renamed.md")).unwrap();
    let renamed = watch.recorder.wait_for(
        "rename Draft.md -> Draft renamed.md",
        std::time::Duration::from_secs(5),
    );
    let (seen, raw) = watch.settle();
    std::fs::remove_dir_all(&root).unwrap();

    assert!(
        renamed,
        "no rename reported; sink saw {seen:?}, backend sent {raw:?}"
    );
    assert!(
        !seen
            .iter()
            .any(|entry| entry.starts_with("change ") || entry.starts_with("unlink ")),
        "a rename must not read as an edit or removal; sink saw {seen:?}, backend sent {raw:?}"
    );
}

/// inotify pairs a rename's halves itself, so a rename reads as one rename
/// however soon the old name is written again. A cloud client renames a
/// note to a conflict name and writes the remote note at the old name
/// (iCloud: "A" -> "A 2", new "A"); dropping the pair for the old name
/// being occupied lost the rename, and an editor open on the note did not
/// follow it.
#[cfg(target_os = "linux")]
#[test]
fn inotify_reports_a_rename_then_a_new_note_at_the_old_name_as_a_rename() {
    let root = temp_vault("recreate");
    let rounds = 20;
    for round in 0..rounds {
        std::fs::write(root.join(format!("A {round}.md")), "local").unwrap();
    }
    let watch = NativeWatch::start(&root);

    for round in 0..rounds {
        std::fs::rename(
            root.join(format!("A {round}.md")),
            root.join(format!("A {round} 2.md")),
        )
        .unwrap();
        // No gap: the remote note is written before the rename is read.
        std::fs::write(root.join(format!("A {round}.md")), "remote").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    let (seen, raw) = watch.settle();
    std::fs::remove_dir_all(&root).unwrap();

    for round in 0..rounds {
        let renamed = format!("rename A {round}.md -> A {round} 2.md");
        assert!(
            seen.contains(&renamed),
            "round {round}: the rename was not reported; sink saw {seen:?}, backend sent {raw:?}"
        );
    }
}

/// vim's default save renames the note to a backup name, writes a new file
/// at the note's path and deletes the backup, so the path is briefly
/// missing. That is an edit of a note that never stopped existing: a
/// removal would drop it from the search index (and close it if open).
#[test]
fn a_vim_style_save_never_reports_the_live_note_removed() {
    let root = temp_vault("vim");
    let note = root.join("note.md");
    let backup = root.join("note.md~");
    std::fs::write(&note, "v0").unwrap();
    let watch = NativeWatch::start(&root);

    for round in 0..24u64 {
        std::fs::rename(&note, &backup).unwrap();
        // The gap between the rename and the rewrite decides whether the
        // backend sees the path missing; cover none, short and long.
        std::thread::sleep(std::time::Duration::from_millis(
            [0, 2, 10][round as usize % 3],
        ));
        std::fs::write(&note, format!("v{}", round + 1)).unwrap();
        std::fs::remove_file(&backup).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
    let (seen, raw) = watch.settle();
    std::fs::remove_dir_all(&root).unwrap();

    assert!(
        !seen
            .iter()
            .any(|entry| entry.starts_with("unlink ") || entry.starts_with("rename ")),
        "a rewrite of note.md read as a removal or rename; sink saw {seen:?}, backend sent {raw:?}"
    );
    assert!(
        seen.iter()
            .any(|entry| entry == "change note.md" || entry == "add note.md"),
        "the rewrite was never reported; sink saw {seen:?}, backend sent {raw:?}"
    );
}

/// An atomic save whose temp file has a note's name (mkstemp with a `.md`
/// suffix, TextEdit's "(A Document Being Saved By …)" folder) moves the
/// temp onto the note. The note must never read as removed, and the report
/// must name it as the destination, so the shell re-reads it.
#[test]
fn an_atomic_save_through_a_note_named_temp_reports_the_note_rewritten() {
    let root = temp_vault("md-temp");
    let note = root.join("note.md");
    std::fs::write(&note, "v0").unwrap();
    std::fs::create_dir_all(root.join("(A Document Being Saved By Editor)")).unwrap();
    let watch = NativeWatch::start(&root);

    let temp = root.join("tmpk3j2v9.md");
    std::fs::write(&temp, "v1").unwrap();
    std::fs::rename(&temp, &note).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(100));
    let temp = root.join("(A Document Being Saved By Editor)/note.md");
    std::fs::write(&temp, "v2").unwrap();
    std::fs::rename(&temp, &note).unwrap();
    let (seen, raw) = watch.settle();
    std::fs::remove_dir_all(&root).unwrap();

    assert!(
        !seen.iter().any(|entry| entry == "unlink note.md"),
        "the rewritten note read as removed; sink saw {seen:?}, backend sent {raw:?}"
    );
    for temp in ["tmpk3j2v9.md", "(A Document Being Saved By Editor)/note.md"] {
        let onto_note = format!("rename {temp} -> note.md");
        assert!(
            seen.contains(&onto_note) || seen.iter().any(|entry| entry == "change note.md"),
            "the save through {temp} never named note.md; sink saw {seen:?}, backend sent {raw:?}"
        );
    }
}

/// A note moved out of the vault (the Trash is outside it) has no new half.
/// Waiting for one must not let it claim the destination of an unrelated
/// atomic save that lands next: that reported the removed note renamed onto
/// the saved one, and an editor open on it followed there.
#[test]
fn a_note_moved_out_of_the_vault_is_removed_and_never_paired_with_an_unrelated_save() {
    let root = temp_vault("out");
    let outside = temp_vault("out-trash");
    let mut runs = Vec::new();
    for delay_ms in [0u64, 30, 150] {
        let gone = format!("Gone {delay_ms}.md");
        let saved = format!("other {delay_ms}.md");
        std::fs::write(root.join(&gone), "gone").unwrap();
        std::fs::write(root.join(&saved), "v0").unwrap();
        let watch = NativeWatch::start(&root);

        std::fs::rename(root.join(&gone), outside.join(&gone)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        let temp = root.join(format!(".{saved}.tmp123"));
        std::fs::write(&temp, "v1").unwrap();
        std::fs::rename(&temp, root.join(&saved)).unwrap();
        runs.push((delay_ms, gone, saved, watch.settle()));
    }
    std::fs::remove_dir_all(&root).unwrap();
    std::fs::remove_dir_all(&outside).unwrap();

    for (delay_ms, gone, saved, (seen, raw)) in runs {
        assert!(
                !seen.iter().any(|entry| entry.starts_with("rename ")),
                "delay {delay_ms} ms: an unrelated save was paired as a rename; sink saw {seen:?}, backend sent {raw:?}"
            );
        assert!(
                seen.contains(&format!("unlink {gone}")),
                "delay {delay_ms} ms: the moved-out note was never reported removed; sink saw {seen:?}, backend sent {raw:?}"
            );
        assert!(
                seen.iter()
                    .any(|entry| *entry == format!("change {saved}") || *entry == format!("add {saved}")),
                "delay {delay_ms} ms: the save was never reported; sink saw {seen:?}, backend sent {raw:?}"
            );
    }
}

/// A note moved out of the vault is reported removed once the pair window
/// closes, on every backend, even when no later event arrives to flush it.
#[test]
fn a_note_moved_out_of_the_vault_is_reported_removed_after_the_pair_window() {
    let root = temp_vault("moved-out");
    let outside = temp_vault("moved-out-trash");
    std::fs::write(root.join("Gone.md"), "gone").unwrap();
    let watch = NativeWatch::start(&root);

    let moved_at = std::time::Instant::now();
    std::fs::rename(root.join("Gone.md"), outside.join("Gone.md")).unwrap();
    let removed = watch
        .recorder
        .wait_for("unlink Gone.md", std::time::Duration::from_secs(3));
    let elapsed = moved_at.elapsed();
    let (seen, raw) = watch.settle();
    std::fs::remove_dir_all(&root).unwrap();
    std::fs::remove_dir_all(&outside).unwrap();

    assert!(
        removed,
        "never reported removed; sink saw {seen:?}, backend sent {raw:?}"
    );
    assert!(
        elapsed >= std::time::Duration::from_millis(RENAME_PAIR_TIMEOUT_MS as u64),
        "reported removed after {elapsed:?}, before its pair window closed"
    );
}
