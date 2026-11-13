use super::*;

#[test]
fn append_adds_text_verbatim_with_no_separator() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("work", "log", "first").unwrap();

    let mutation = store.append("work/log", "second\n").unwrap();

    assert_eq!(mutation.final_id.as_deref(), Some("work/log"));
    assert_eq!(store.read("work/log").unwrap(), "firstsecond\n");
}

#[test]
fn an_empty_append_leaves_the_file_untouched() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "log", "body").unwrap();
    let path = root.0.join("log.md");
    set_file_mtime_ms(&path, 1_000_000).unwrap();

    let mutation = store.append("log", "").unwrap();

    assert_eq!(mutation.final_id.as_deref(), Some("log"));
    assert_eq!(store.read("log").unwrap(), "body");
    assert_eq!(file_mtime_ms(&fs::metadata(&path).unwrap()), 1_000_000);
}

#[test]
fn appending_to_a_missing_note_creates_nothing() {
    let root = TestRoot::new();
    let store = store(&root);

    assert_eq!(store.append("ghost", "text").unwrap_err(), NOTE_NOT_FOUND);
    assert!(!store.exists("ghost"));
}

#[test]
fn concurrent_appends_each_land_exactly_once() {
    let root = TestRoot::new();
    let store = Arc::new(store(&root));
    store.create("", "log", "").unwrap();

    let writers = (0..16)
        .map(|index| {
            let store = Arc::clone(&store);
            std::thread::spawn(move || store.append("log", &format!("[{index}]")).unwrap())
        })
        .collect::<Vec<_>>();
    for writer in writers {
        writer.join().unwrap();
    }

    let body = store.read("log").unwrap();
    for index in 0..16 {
        assert_eq!(body.matches(&format!("[{index}]")).count(), 1, "{body}");
    }
}

#[test]
fn append_refuses_an_unsafe_id() {
    let root = TestRoot::new();
    let store = store(&root);

    assert!(store.append("../outside", "text").is_err());
    assert!(!root.0.parent().unwrap().join("outside.md").exists());
}
