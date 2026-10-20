use super::*;

// --- vault walk and list cache ---

#[cfg(unix)]
#[test]
fn the_vault_walk_skips_hidden_entries_and_symlinks_and_caps_depth() {
    let root = TestRoot::new();
    let outside = TestRoot::new();
    fs::write(outside.0.join("secret.md"), "outside").unwrap();
    fs::create_dir_all(root.0.join(".hidden")).unwrap();
    fs::write(root.0.join(".hidden/note.md"), "hidden").unwrap();
    fs::write(root.0.join(".dotted.md"), "hidden").unwrap();
    fs::write(root.0.join("kept.md"), "kept #tag").unwrap();
    std::os::unix::fs::symlink(root.0.join("kept.md"), root.0.join("link.md")).unwrap();
    std::os::unix::fs::symlink(&outside.0, root.0.join("escape")).unwrap();
    let mut deep = root.0.clone();
    const MAX_FOLDER_DEPTH: usize = futo_notes_core::files::MAX_FOLDER_DEPTH;
    for level in 0..=MAX_FOLDER_DEPTH {
        deep.push(format!("d{level}"));
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("n.md"), "deep").unwrap();
    }

    let snapshot = store(&root).bootstrap().unwrap().snapshot;
    let mut ids: Vec<_> = snapshot.notes.iter().map(|note| note.id.clone()).collect();
    ids.sort();
    let chain = |levels: usize| {
        (0..levels)
            .map(|level| format!("d{level}"))
            .collect::<Vec<_>>()
            .join("/")
    };
    let mut expected: Vec<_> = (1..=MAX_FOLDER_DEPTH)
        .map(|levels| format!("{}/n", chain(levels)))
        .collect();
    expected.push("kept".into());
    expected.sort();
    assert_eq!(
        ids, expected,
        "one note past the depth cap, symlinks and hidden entries are skipped"
    );
    assert!(snapshot.folders.contains(&chain(MAX_FOLDER_DEPTH + 1)));
    assert!(!snapshot
        .folders
        .iter()
        .any(|folder| folder.starts_with("escape") || folder.starts_with('.')));
    let listing = store(&root).startup_listing();
    assert_eq!(listing.notes.len(), snapshot.notes.len());
    assert_eq!(listing.folders, snapshot.folders);
}

#[test]
fn the_list_cache_never_changes_what_a_vault_open_returns() {
    let root = TestRoot::new();
    let index = TestRoot::new();
    let index_dir = index.0.join("search");
    let cache_file = crate::list_cache::cache_file_path(&index_dir);
    for (id, body) in [
        ("Plain", "Just a note. #root"),
        ("Area/Nested", "# Heading\n\n- [ ] task\n\n#work #idea"),
        (
            "Area/Deeper/Code",
            "```\n#not_a_tag\n```\n![img](a.png) #real",
        ),
        ("Unicode", "日本語 🎉 café #tag"),
    ] {
        fs::create_dir_all(root.0.join(id).parent().unwrap()).unwrap();
        fs::write(root.0.join(format!("{id}.md")), body).unwrap();
    }
    let open = || {
        let store = store(&root);
        let snapshot = store
            .bootstrap_with_search(index_dir.clone(), Arc::new(|_| {}))
            .unwrap()
            .snapshot;
        store.list_cache.wait_for_pending_write();
        (store, snapshot)
    };

    let trusted_now = crate::list_cache::now_ns() + 10 * crate::list_cache::RACY_MARGIN_NS;
    let (store, cold) = open();
    assert_eq!(cold, uncached(&root));
    let written = fs::read(&cache_file).unwrap();
    store.list_cache.set_built_at_for_test(trusted_now);
    assert_eq!(store.snapshot(), uncached(&root));
    store.list_cache.wait_for_pending_write();
    assert_eq!(
        fs::read(&cache_file).unwrap(),
        written,
        "an all-hit open writes nothing"
    );

    // A trusted entry is served without reading the note.
    let path = root.0.join("Plain.md");
    let mut planted = cold
        .notes
        .iter()
        .find(|note| note.id == "Plain")
        .unwrap()
        .clone();
    planted.preview = "served from the cache".into();
    let fingerprint = crate::list_cache::Fingerprint::of(&fs::metadata(&path).unwrap());
    store.list_cache.commit(
        &crate::list_cache::canonicalize_or(&root.0),
        0,
        Some(vec![crate::list_cache::Entry::of(&planted, fingerprint)]),
    );
    store.list_cache.wait_for_pending_write();
    store.list_cache.set_built_at_for_test(trusted_now);
    let hit = store.snapshot();
    assert_eq!(
        hit.notes
            .iter()
            .find(|note| note.id == "Plain")
            .unwrap()
            .preview,
        "served from the cache"
    );
    store.list_cache.wait_for_pending_write();

    // Edits behind the store's back always win over the cache, including one
    // that keeps the size and restores the mtime (only ctime/inode move).
    let mtime = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, "Just a NOTE. #root").unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(mtime)
        .unwrap();
    fs::rename(root.0.join("Unicode.md"), root.0.join("Area/Renamed.md")).unwrap();
    fs::remove_file(root.0.join("Area/Deeper/Code.md")).unwrap();
    fs::write(root.0.join("Added.md"), "new #fresh").unwrap();
    store.list_cache.set_built_at_for_test(trusted_now);
    assert_eq!(store.snapshot(), uncached(&root));
    store.list_cache.wait_for_pending_write();

    // A corrupt file is a cold start, never an error.
    store.list_cache.wait_for_pending_write();
    fs::write(&cache_file, b"garbage").unwrap();
    assert_eq!(open().1, uncached(&root));
}

/// A note written just before a cache write is racy against it. Once a later
/// open re-reads it outside the margin, the cache is persisted again so the
/// next launch serves it instead of re-reading it forever.
#[test]
fn a_verified_racy_note_is_persisted_as_a_hit_once_it_ages_out() {
    let root = TestRoot::new();
    let index = TestRoot::new();
    let index_dir = index.0.join("search");
    let note = root.0.join("Note.md");
    fs::write(&note, "just synced #fresh").unwrap();
    let cache_file = crate::list_cache::cache_file_path(&index_dir);
    let open = || {
        let store = store(&root);
        store
            .bootstrap_with_search(index_dir.clone(), Arc::new(|_| {}))
            .unwrap();
        store.list_cache.wait_for_pending_write();
        store
    };

    open();
    let written = fs::read(&cache_file).unwrap();
    std::thread::sleep(
        Duration::from_nanos(crate::list_cache::RACY_MARGIN_NS as u64) + Duration::from_millis(200),
    );
    open();
    assert_ne!(fs::read(&cache_file).unwrap(), written);
    let (generation, built_at_ns) = open().list_cache.current();
    let fingerprint = crate::list_cache::Fingerprint::of(&fs::metadata(&note).unwrap());
    assert_eq!(generation.get("Note").unwrap().fingerprint, fingerprint);
    assert!(!fingerprint.is_racy(built_at_ns - crate::list_cache::RACY_MARGIN_NS));
}
