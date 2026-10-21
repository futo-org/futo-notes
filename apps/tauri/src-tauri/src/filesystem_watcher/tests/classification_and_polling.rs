//! Event classification, and the poll backend against a real directory.

use super::*;

#[test]
fn events_are_classified_without_metadata_noise() {
    assert_eq!(
        classify(
            &Event::new(EventKind::Create(notify::event::CreateKind::File)),
            WatchMode::Inotify
        ),
        Some(ChangeKind::Add)
    );
    assert_eq!(
        classify(
            &Event::new(EventKind::Modify(ModifyKind::Metadata(
                notify::event::MetadataKind::Permissions
            ))),
            WatchMode::Inotify
        ),
        None
    );
    assert_eq!(
        classify(
            &Event::new(EventKind::Remove(notify::event::RemoveKind::File)),
            WatchMode::Inotify
        ),
        Some(ChangeKind::Unlink)
    );
}

/// The poll backend's only signal for "this file was edited" is a WriteTime
/// metadata event. Dropping it as noise — which the native-backend rule does —
/// would leave a polled vault silent about every external edit.
#[test]
fn a_polled_write_time_change_is_an_edit_but_native_write_time_is_noise() {
    let write_time = Event::new(EventKind::Modify(ModifyKind::Metadata(
        MetadataKind::WriteTime,
    )));
    assert_eq!(
        classify(&write_time, WatchMode::Poll),
        Some(ChangeKind::Change)
    );
    assert_eq!(classify(&write_time, WatchMode::Inotify), None);

    // Permission changes stay noise under both backends.
    let permissions = Event::new(EventKind::Modify(ModifyKind::Metadata(
        MetadataKind::Permissions,
    )));
    assert_eq!(classify(&permissions, WatchMode::Poll), None);
    assert_eq!(classify(&permissions, WatchMode::Inotify), None);
}

/// An ordinary vault must keep using inotify: polling every couple of seconds
/// is a fallback for filesystems that lie, not a new default.
#[test]
fn an_ordinary_vault_is_watched_by_inotify() {
    assert_eq!(watch_mode(&std::env::temp_dir()), WatchMode::Inotify);
}

/// The poll backend really does deliver an external edit that inotify would
/// miss on a doc-portal mount. Uses a real directory (inotify would work here
/// too) because what is under test is the PollWatcher + `classify` pairing:
/// notify reports the edit as WriteTime metadata, and this asserts the change
/// reaches the sink as an edit.
#[test]
fn the_poll_backend_reports_an_external_edit() {
    let root = std::env::temp_dir().join(format!(
        "futo-poll-watch-{}-{}",
        std::process::id(),
        futo_notes_core::files::now_ms()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let note = root.join("note.md");
    std::fs::write(&note, "before").unwrap();

    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let recorder = seen.clone();
    let mut watcher = PollWatcher::new(
        move |result: Result<Event, notify::Error>| {
            let Ok(event) = result else { return };
            if let Some(kind) = classify(&event, WatchMode::Poll) {
                if kind == ChangeKind::Change {
                    for path in &event.paths {
                        recorder
                            .lock()
                            .unwrap()
                            .push(path.to_string_lossy().into_owned());
                    }
                }
            }
        },
        Config::default().with_poll_interval(std::time::Duration::from_millis(100)),
    )
    .unwrap();
    watcher.watch(&root, RecursiveMode::Recursive).unwrap();

    // mtime has one-second granularity on some filesystems, so make the edit
    // unambiguously newer than the initial scan.
    std::thread::sleep(std::time::Duration::from_millis(1_100));
    std::fs::write(&note, "after the edit").unwrap();

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if !seen.lock().unwrap().is_empty() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let observed = seen.lock().unwrap().clone();
    drop(watcher);
    std::fs::remove_dir_all(&root).unwrap();

    assert!(
        observed.iter().any(|path| path.ends_with("note.md")),
        "the poll watcher never reported the edit; saw {observed:?}"
    );
}
