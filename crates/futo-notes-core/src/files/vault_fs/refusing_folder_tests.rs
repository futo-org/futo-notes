//! `refuse_writes_in`: a test stand-in for a read-only folder that works for
//! every uid and platform. Gated on `test` alone, like `contract_tests`.

/// Every entry under `root` with what a refused operation must not change: its
/// kind, bytes, mode and inode.
fn disk_state(root: &std::path::Path) -> Vec<String> {
    fn walk(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<String>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        entries.sort();
        for path in entries {
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            #[cfg(unix)]
            let identity = {
                use std::os::unix::fs::MetadataExt;
                format!("{:o} inode {}", metadata.mode(), metadata.ino())
            };
            #[cfg(not(unix))]
            let identity = String::new();
            let content = if metadata.is_file() {
                format!("{:?}", std::fs::read(&path).unwrap())
            } else {
                String::new()
            };
            let name = path.strip_prefix(root).unwrap().display();
            out.push(format!("{name} {identity} {content}"));
            if metadata.is_dir() {
                walk(root, &path, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out
}

/// The hook behind `refuse_writes_in` is decided before an operation runs, so
/// a refused one changes nothing, and it does not depend on the uid or the
/// platform (root and Windows ignore the mode bits it stands in for).
#[test]
fn a_folder_that_refuses_writes_refuses_every_change_inside_it_and_changes_nothing() {
    use crate::files::vault_fs::{
        allow_writes_in, create_dir, create_dir_all, create_new, create_new_in_existing_parent,
        create_new_strict, move_no_replace, move_no_replace_in_existing_parent,
        move_no_replace_strict, read, refuse_writes_in, remove, remove_dir, remove_local, rename,
        rename_case, rename_local, write_atomic, write_atomic_local,
        write_atomic_local_in_existing_parent,
    };
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    write_atomic(root, "locked/note.md", b"body").unwrap();
    write_atomic(root, "open/note.md", b"body").unwrap();
    std::fs::create_dir(root.join("locked/empty")).unwrap();
    let locked = root.join("locked");
    refuse_writes_in(&locked);
    let before = disk_state(root);

    let refused: Vec<(&str, Result<(), String>)> = vec![
        ("write", write_atomic(root, "locked/note.md", b"new")),
        ("write new", write_atomic(root, "locked/other.md", b"new")),
        (
            "write local",
            write_atomic_local(root, "locked/note.md", b"new").map_err(String::from),
        ),
        (
            "write in parent",
            write_atomic_local_in_existing_parent(root, "locked/note.md", b"new")
                .map_err(String::from),
        ),
        (
            "create",
            create_new(root, "locked/other.md", b"new").map(drop),
        ),
        // An exclusive create writes a sibling temp file first: refused even
        // when the final name is taken.
        (
            "create taken",
            create_new(root, "locked/note.md", b"new").map(drop),
        ),
        (
            "create in parent",
            create_new_in_existing_parent(root, "locked/other.md", b"new").map(drop),
        ),
        (
            "create strict",
            create_new_strict(root, "locked/other.md", b"new").map(drop),
        ),
        ("remove", remove(root, "locked/note.md").map(drop)),
        (
            "remove local",
            remove_local(root, "locked/note.md").map(drop),
        ),
        (
            "rename out",
            rename(root, "locked/note.md", "open/moved.md").map(drop),
        ),
        (
            "rename in",
            rename(root, "open/note.md", "locked/moved.md").map(drop),
        ),
        (
            "rename local",
            rename_local(root, "locked/note.md", "open/moved.md").map(drop),
        ),
        (
            "rename case",
            rename_case(root, "locked/note.md", "locked/NOTE.md"),
        ),
        (
            "move into",
            move_no_replace(root, "open/note.md", "locked/new.md").map(drop),
        ),
        (
            "move out",
            move_no_replace(root, "locked/note.md", "open/new.md").map(drop),
        ),
        (
            "move in parent",
            move_no_replace_in_existing_parent(root, "locked/note.md", "open/new.md").map(drop),
        ),
        (
            "move strict",
            move_no_replace_strict(root, "locked/note.md", "open/new.md").map(drop),
        ),
        ("create folder", create_dir(root, "locked/sub")),
        ("create folders", create_dir_all(root, "locked/new")),
        (
            "create nested folders",
            create_dir_all(root, "locked/new/sub"),
        ),
        ("remove folder", remove_dir(root, "locked/empty", false)),
    ];
    for (what, result) in refused {
        let error = result.unwrap_err();
        assert!(error.contains("ermission denied"), "{what}: {error}");
        assert_eq!(disk_state(root), before, "{what} changed the disk");
    }

    // What a real read-only folder lets through.
    assert!(!move_no_replace(root, "open/note.md", "locked/note.md").unwrap());
    create_dir_all(root, "locked/empty").unwrap();
    create_dir_all(root, "open/sub").unwrap();
    write_atomic(root, "open/note.md", b"new").unwrap();
    assert_eq!(read(root, "locked/note.md").unwrap(), b"body");

    // A bad operand reports its own error, not a denial.
    for (from, to) in [
        ("locked/note.md", "../escape.md"),
        ("../escape.md", "locked/new.md"),
    ] {
        let state = disk_state(root);
        let error = rename(root, from, to).unwrap_err();
        assert!(
            !error.contains("ermission denied"),
            "{from} -> {to}: {error}"
        );
        let error = move_no_replace(root, from, to).unwrap_err();
        assert!(
            !error.contains("ermission denied"),
            "{from} -> {to}: {error}"
        );
        assert_eq!(disk_state(root), state);
    }

    allow_writes_in(&locked);
    assert!(remove(root, "locked/note.md").unwrap());
    assert!(create_new(root, "locked/other.md", b"new").unwrap());
    assert!(move_no_replace(root, "open/note.md", "locked/new.md").unwrap());
}

/// A symlink operand is rejected as a symlink even when the other operand's
/// folder refuses.
#[cfg(unix)]
#[test]
fn a_symlink_operand_is_reported_as_one_not_as_a_denial() {
    use crate::files::vault_fs::{allow_writes_in, move_no_replace, refuse_writes_in, rename};
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    std::fs::create_dir_all(root.join("locked")).unwrap();
    std::fs::write(root.join("locked/note.md"), "body").unwrap();
    std::fs::create_dir(root.join("open")).unwrap();
    std::os::unix::fs::symlink(root.join("open"), root.join("link")).unwrap();
    refuse_writes_in(&root.join("locked"));
    let before = disk_state(root);

    let error = rename(root, "locked/note.md", "link/new.md").unwrap_err();
    assert!(error.contains("symlink"), "{error}");
    let error = move_no_replace(root, "locked/note.md", "link/new.md").unwrap_err();
    assert!(error.contains("symlink"), "{error}");
    assert_eq!(disk_state(root), before);
    allow_writes_in(&root.join("locked"));
}
