use super::*;

#[cfg(unix)]
#[test]
fn note_workflows_reject_symlinked_parents_and_leaves() {
    use std::os::unix::fs::symlink;
    let root = TestRoot::new();
    let outside = TestRoot::new();
    fs::write(outside.0.join("secret.md"), "outside").unwrap();
    symlink(&outside.0, root.0.join("linked")).unwrap();
    symlink(outside.0.join("secret.md"), root.0.join("leaf.md")).unwrap();
    let store = store(&root);
    for id in ["linked/secret", "leaf"] {
        assert!(store.read_existing(id).is_err(), "read escaped via {id}");
        assert!(
            store.write(id, "replacement", None).is_err(),
            "write escaped via {id}"
        );
        assert!(store.flush_draft(id, "outside", "draft").is_err());
        assert!(store.rename(id, "Moved").is_err());
        assert!(store.delete(id).is_err());
    }
    assert!(store.create("linked", "new", "new").is_err());
    assert!(store.create_folder("linked/nested").is_err());
    assert_eq!(
        fs::read_to_string(outside.0.join("secret.md")).unwrap(),
        "outside"
    );
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn a_parent_swapped_after_validation_cannot_redirect_a_write() {
    struct SwapParent {
        root: PathBuf,
        outside: PathBuf,
    }
    impl BeforeWrite for SwapParent {
        fn before_write(&self, _: &[FileChange]) {
            fs::rename(self.root.join("folder"), self.root.join("original-folder")).unwrap();
            std::os::unix::fs::symlink(&self.outside, self.root.join("folder")).unwrap();
        }
    }
    let root = TestRoot::new();
    let outside = TestRoot::new();
    fs::create_dir(root.0.join("folder")).unwrap();
    fs::write(root.0.join("folder/note.md"), "base").unwrap();
    fs::write(outside.0.join("note.md"), "outside").unwrap();
    let store = LocalNoteStore::with_before_write(
        root.0.clone(),
        Arc::new(SwapParent {
            root: root.0.clone(),
            outside: outside.0.clone(),
        }),
    );
    assert!(store.write("folder/note", "draft", None).is_err());
    assert_eq!(
        fs::read_to_string(outside.0.join("note.md")).unwrap(),
        "outside"
    );
    assert_eq!(
        fs::read_to_string(root.0.join("original-folder/note.md")).unwrap(),
        "base"
    );
}

fn listed_ids(store: &LocalNoteStore) -> (Vec<String>, Vec<String>) {
    let listing = store
        .startup_listing()
        .notes
        .into_iter()
        .map(|note| note.id)
        .collect();
    (listing, ids_in_order(store))
}

// Linux and macOS allow `\` inside a filename; it must not read as a folder
// separator, or `a\b.md` becomes a second `a/b` beside the real `a/b.md`.
#[cfg(unix)]
#[test]
fn a_backslash_filename_does_not_alias_a_folder_note() {
    let root = TestRoot::new();
    fs::create_dir_all(root.0.join("a")).unwrap();
    fs::write(root.0.join("a/b.md"), "real").unwrap();
    fs::write(root.0.join("a\\b.md"), "alias").unwrap();
    let only_the_real_note = vec!["a/b".to_owned()];
    assert_eq!(
        listed_ids(&store(&root)),
        (only_the_real_note.clone(), only_the_real_note)
    );
}

// Linux filenames are bytes. A name that is not UTF-8 has no note id: a lossy
// decode would turn every invalid byte into U+FFFD, so two names shared one.
#[cfg(target_os = "linux")]
#[test]
fn non_utf8_filenames_are_not_notes() {
    use std::os::unix::ffi::OsStrExt;
    let root = TestRoot::new();
    for name in [b"caf\xe9.md".as_slice(), b"caf\xe8.md".as_slice()] {
        fs::write(
            root.0.join(std::ffi::OsStr::from_bytes(name)),
            "latin-1 name",
        )
        .unwrap();
    }
    fs::write(root.0.join("plain.md"), "utf-8 name").unwrap();
    let only_the_utf8_note = vec!["plain".to_owned()];
    assert_eq!(
        listed_ids(&store(&root)),
        (only_the_utf8_note.clone(), only_the_utf8_note)
    );
}

// A Unix folder named `x\y` is not listed: it is not the folders `x` and `x/y`
// (which do not exist), and no folder path can hold a `\`. Other empty
// folders, even ones the app would not create (`Misc.`, `Aux`), still list.
#[cfg(unix)]
#[test]
fn a_backslash_folder_name_is_not_listed_or_split() {
    let root = TestRoot::new();
    for folder in ["x\\y", "Misc.", "Aux"] {
        fs::create_dir_all(root.0.join(folder)).unwrap();
    }
    assert_eq!(store(&root).snapshot().folders, ["Aux", "Misc."]);
}

// The parallel walk behind every open (cached or not) and every stat-only
// projection names files exactly as `vault_fs::relative_name` does: nothing
// under a `\` folder is a note or a folder, and a `\` file never aliases.
#[cfg(unix)]
#[test]
fn every_vault_walk_names_files_by_their_vault_name() {
    let root = TestRoot::new();
    let index = TestRoot::new();
    fs::create_dir_all(root.0.join("a")).unwrap();
    fs::create_dir_all(root.0.join("x\\y/sub")).unwrap();
    fs::write(root.0.join("a/b.md"), "real").unwrap();
    fs::write(root.0.join("a\\b.md"), "alias").unwrap();
    fs::write(root.0.join("x\\y/inner.md"), "under a backslash folder").unwrap();
    fs::write(root.0.join("x\\y/sub/deeper.md"), "deeper").unwrap();
    fs::write(root.0.join("Top.md"), "top").unwrap();

    let store = store(&root);
    let opened = store
        .bootstrap_with_search(index.0.join("search"), Arc::new(|_| {}))
        .unwrap()
        .snapshot;
    store.list_cache.wait_for_pending_write();
    let mut ids: Vec<_> = opened.notes.iter().map(|note| note.id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, ["Top", "a/b"]);
    assert_eq!(opened.folders, ["a"]);
    assert_eq!(opened.notes, uncached(&root).notes);
    let listing = store.startup_listing();
    let listed: Vec<_> = listing.notes.iter().map(|note| note.id.as_str()).collect();
    let snapped: Vec<_> = opened.notes.iter().map(|note| note.id.as_str()).collect();
    assert_eq!(listed, snapped);
    assert_eq!(listing.folders, opened.folders);
    let (order, folders) = crate::vault::note_order_and_folders(&root.0, store.sort_order());
    assert_eq!(order, snapped);
    assert_eq!(folders, opened.folders);
    assert_eq!(crate::vault::folders(&root.0), opened.folders);
    let mut paths: Vec<_> = crate::vault::note_paths(&root.0)
        .into_iter()
        .map(|(id, path)| (id, path.strip_prefix(&root.0).unwrap().to_owned()))
        .collect();
    paths.sort();
    assert_eq!(
        paths,
        [
            ("Top".to_owned(), "Top.md".into()),
            ("a/b".to_owned(), std::path::PathBuf::from("a/b.md")),
        ]
    );
}

// A relink rewrites other notes' bodies, so it must never re-encode one: a
// note that is not valid UTF-8 (a Latin-1 file another editor left in the
// vault) is skipped byte-for-byte, and the skip is reported. Decoding it
// lossily and writing it back destroyed every such byte irrecoverably, and the
// now-valid file then synced to every device. Both relink entry points: a
// note rename and a folder rename.
#[test]
fn a_relink_never_rewrites_a_note_that_is_not_utf8() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("Target", "target body", None).unwrap();
    store.write("Box/Filed", "filed body", None).unwrap();
    store.write("Linker", "see [[Target]]", None).unwrap();
    // "caf\xe9 [[Target]] [[Box/Filed]]": a Latin-1 e-acute, invalid as UTF-8.
    let latin: &[u8] = b"caf\xe9 [[Target]] [[Box/Filed]]";
    fs::write(root.0.join("Latin.md"), latin).unwrap();

    let renamed = store.rename("Target", "Target moved").unwrap();
    assert_eq!(fs::read(root.0.join("Latin.md")).unwrap(), latin);
    assert_eq!(store.read("Linker").unwrap(), "see [[Target moved]]");
    assert_eq!(renamed.relinked, vec!["Linker".to_owned()]);
    assert!(
        renamed
            .warnings
            .iter()
            .any(|warning| warning.contains("Latin")),
        "the skipped note is reported: {:?}",
        renamed.warnings
    );

    store.rename_folder("Box", "Crate").unwrap();
    assert_eq!(fs::read(root.0.join("Latin.md")).unwrap(), latin);
}

// A note that exists but cannot be decoded is a read FAILURE, never an empty
// note: the desktop loader turns a failed read into "go home, create nothing",
// while an empty answer opened the note as a blank page whose every save then
// failed. A missing note still reads as empty (a broken wikilink opens through
// the ordinary path and is created on its first save).
#[test]
fn a_note_that_is_not_utf8_fails_to_read_instead_of_reading_empty() {
    let root = TestRoot::new();
    let store = store(&root);
    let latin: &[u8] = b"caf\xe9 au lait";
    fs::write(root.0.join("Latin.md"), latin).unwrap();
    assert!(store.exists("Latin"));
    let read = store.read("Latin");
    assert!(
        read.is_err(),
        "an existing, non-empty note read as {read:?}"
    );
    assert_eq!(store.read("Missing").unwrap(), "");
    assert_eq!(fs::read(root.0.join("Latin.md")).unwrap(), latin);
}

// The read side of RC-48. A file holding a lone UTF-16 surrogate as WTF-8 bytes
// (ED A0 80: what a UTF-16 program writes without repairing) is not UTF-8, so it
// is refused exactly like the Latin-1 note above: an error, never an editor
// document carrying a surrogate, and the bytes stay as they are. The editor
// writes such a surrogate as U+FFFD on the way out (decision 16A), so a save
// never produces these bytes and a read never has to repair them.
#[test]
fn a_note_holding_wtf8_surrogate_bytes_fails_to_read_and_is_left_alone() {
    let root = TestRoot::new();
    let store = store(&root);
    let wtf8: &[u8] = b"lone \xed\xa0\x80 high, lone \xed\xb8\x80 low";
    fs::write(root.0.join("Wtf8.md"), wtf8).unwrap();
    assert!(store.read("Wtf8").is_err());
    assert_eq!(fs::read(root.0.join("Wtf8.md")).unwrap(), wtf8);

    // What the editor sends for the same text: U+FFFD, three valid bytes each.
    store
        .write("Fixed", "lone \u{FFFD} high, lone \u{FFFD} low", None)
        .unwrap();
    assert_eq!(
        fs::read(root.0.join("Fixed.md")).unwrap(),
        "lone \u{FFFD} high, lone \u{FFFD} low".as_bytes()
    );
    assert_eq!(
        store.read("Fixed").unwrap(),
        "lone \u{FFFD} high, lone \u{FFFD} low"
    );
}

// A relink rewrites notes nobody asked to change, one of which may be open in
// an editor that still holds the pre-rename bytes. The mutation names every
// note whose body it rewrote — by final id, including the renamed note's own
// self-link — so the editor adopts those bytes instead of reading the
// difference as a peer's edit and parking a conflict copy on its next save.
#[test]
fn a_relink_reports_every_note_whose_body_it_rewrote() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("Target", "target body", None).unwrap();
    store.write("Hub", "see [[Target]] here", None).unwrap();
    store.write("Bystander", "no links", None).unwrap();

    // Renaming ANOTHER note: the linking note is reported, the moved one and a
    // note without a matching link are not.
    let renamed = store.rename("Target", "Target moved").unwrap();
    assert_eq!(store.read("Hub").unwrap(), "see [[Target moved]] here");
    assert_eq!(renamed.relinked, vec!["Hub".to_owned()]);

    // A folder rename reports the note OUTSIDE the folder that links into it.
    store.write("Box/Filed", "filed", None).unwrap();
    store.write("Index", "[[Box/Filed]]", None).unwrap();
    let folder = store.rename_folder("Box", "Crate").unwrap();
    assert_eq!(store.read("Index").unwrap(), "[[Crate/Filed]]");
    assert_eq!(folder.relinked, vec!["Index".to_owned()]);

    // The editor's own title rename rewrites the note's self-link: reported at
    // the final id, next to the draft the editor sent.
    store.write("Journal", "back to [[Journal]]", None).unwrap();
    let retitled = store
        .save_draft_as(
            "Journal",
            "Diary",
            "back to [[Journal]]",
            "back to [[Journal]] today",
        )
        .unwrap();
    assert_eq!(store.read("Diary").unwrap(), "back to [[Diary]] today");
    assert_eq!(retitled.relinked, vec!["Diary".to_owned()]);

    // A rename that rewrites no link reports nothing.
    let plain = store.rename("Bystander", "Bystander moved").unwrap();
    assert!(plain.relinked.is_empty(), "{:?}", plain.relinked);
}
