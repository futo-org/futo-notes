use super::*;

#[test]
fn reset_removes_every_vault_entry_but_never_the_vault_directory() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "body", None).unwrap();
    fs::write(root.0.join("image.png"), [1, 2, 3]).unwrap();
    fs::write(root.0.join(".app-state"), "state").unwrap();
    store.reset().unwrap();
    assert!(root.0.is_dir());
    assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
}

#[test]
fn vault_migration_copies_every_entry_and_deletes_source_only_after_finalize() {
    let source = TestRoot::new();
    let destination = TestRoot::new();
    let store = store(&source);
    store.write("Folder/note", "body", None).unwrap();
    fs::write(source.0.join("image.png"), [1, 2, 3]).unwrap();
    fs::write(source.0.join(".e2ee-state.json"), "checkpoint").unwrap();

    let outcome = store.stage_vault_migration(&destination.0).unwrap();

    assert_eq!(outcome.status, VaultMigrationStatus::Migrated);
    assert_eq!(
        fs::read_to_string(destination.0.join("Folder/note.md")).unwrap(),
        "body"
    );
    assert_eq!(
        fs::read(destination.0.join("image.png")).unwrap(),
        [1, 2, 3]
    );
    assert_eq!(
        fs::read_to_string(destination.0.join(".e2ee-state.json")).unwrap(),
        "checkpoint"
    );
    assert!(source.0.join("Folder/note.md").exists());

    assert_eq!(
        store
            .finalize_vault_migration(&destination.0, true)
            .unwrap(),
        VaultMigrationFinalization::Finalized
    );
    assert!(!source.0.exists());
}

#[test]
fn vault_migration_refuses_a_different_destination_without_changing_either_vault() {
    let source = TestRoot::new();
    let destination = TestRoot::new();
    let store = store(&source);
    store.write("note", "source", None).unwrap();
    fs::write(destination.0.join("note.md"), "destination").unwrap();

    assert!(store.stage_vault_migration(&destination.0).is_err());

    assert_eq!(store.read("note").unwrap(), "source");
    assert_eq!(
        fs::read_to_string(destination.0.join("note.md")).unwrap(),
        "destination"
    );
}

#[test]
fn vault_migration_finalize_refuses_to_delete_a_changed_source() {
    let source = TestRoot::new();
    let destination = TestRoot::new();
    let store = store(&source);
    store.write("note", "source", None).unwrap();
    store.stage_vault_migration(&destination.0).unwrap();
    store.write("late", "new edit", None).unwrap();

    assert_eq!(
        store
            .finalize_vault_migration(&destination.0, true)
            .unwrap(),
        VaultMigrationFinalization::DestinationChanged
    );
    assert!(source.0.exists());
    assert_eq!(store.read("late").unwrap(), "new edit");
}

#[cfg(unix)]
#[test]
fn vault_migration_finalize_does_not_treat_an_uninspectable_source_as_absent() {
    use std::os::unix::fs::symlink;

    let source = TestRoot::new();
    let destination = TestRoot::new();
    let store = store(&source);
    store.write("note", "source", None).unwrap();
    store.stage_vault_migration(&destination.0).unwrap();

    fs::remove_dir_all(&source.0).unwrap();
    symlink(&source.0, &source.0).unwrap();
    fs::write(destination.0.join("note.md"), "changed destination").unwrap();

    let error = store
        .finalize_vault_migration(&destination.0, true)
        .unwrap_err();

    assert!(error.contains("unable to inspect the current notes folder"));
    assert_eq!(
        fs::read_to_string(destination.0.join("note.md")).unwrap(),
        "changed destination"
    );
}

#[test]
fn vault_migration_retains_a_shared_source_that_external_writers_can_reach() {
    let source = TestRoot::new();
    let destination = TestRoot::new();
    let store = store(&source);
    store.write("note", "source", None).unwrap();
    store.stage_vault_migration(&destination.0).unwrap();

    assert_eq!(
        store
            .finalize_vault_migration(&destination.0, false)
            .unwrap(),
        VaultMigrationFinalization::SourceRetained
    );
    assert_eq!(store.read("note").unwrap(), "source");
}

#[test]
fn vault_migration_retains_an_empty_shared_source() {
    let source = TestRoot::new();
    let destination = source.0.with_extension("new-shared-location");
    let store = store(&source);

    let outcome = store.stage_vault_migration(&destination).unwrap();

    assert_eq!(outcome.status, VaultMigrationStatus::EmptySource);
    assert_eq!(
        store.finalize_vault_migration(&destination, false).unwrap(),
        VaultMigrationFinalization::SourceRetained
    );
    assert!(source.0.is_dir());
}

#[test]
fn empty_vault_migration_does_not_require_a_destination_to_finalize() {
    let source = TestRoot::new();
    let destination = source.0.with_extension("new-location");
    let store = store(&source);

    let outcome = store.stage_vault_migration(&destination).unwrap();

    assert_eq!(outcome.status, VaultMigrationStatus::EmptySource);
    assert!(!destination.exists());
    assert_eq!(
        store.finalize_vault_migration(&destination, true).unwrap(),
        VaultMigrationFinalization::Finalized
    );
    assert!(!source.0.exists());
}

#[test]
fn empty_vault_migration_refuses_an_unrelated_nonempty_destination() {
    let source = TestRoot::new();
    let destination = TestRoot::new();
    let store = store(&source);
    fs::write(destination.0.join("unrelated.md"), "keep me").unwrap();

    assert!(store.stage_vault_migration(&destination.0).is_err());

    assert!(source.0.exists());
    assert_eq!(
        fs::read_to_string(destination.0.join("unrelated.md")).unwrap(),
        "keep me"
    );
}
