use super::{self as vault_fs, RecoveryActivation};

#[cfg(unix)]
#[test]
fn prepared_recovery_rejects_note_install_bypass_and_reports_linked_foreign_inode() {
    let root = tempfile::tempdir().unwrap();
    vault_fs::create_new_strict(root.path(), "note.md", b"source").unwrap();
    assert!(vault_fs::prepare_recovery_activation(root.path(), "note.md", "other.md").is_err());
    let source = ".futo-editor-recovery/owned.prepared";
    let live = ".futo-editor-recovery/live.jsonl";
    vault_fs::create_new_strict(root.path(), source, b"header\nedit\n").unwrap();
    let mut prepared = vault_fs::prepare_recovery_activation(root.path(), source, live).unwrap();
    let path = root.path().to_owned();
    vault_fs::set_before_install_hook(Some(Box::new(move |_| {
        std::fs::remove_file(path.join(source)).unwrap();
        std::fs::write(path.join(source), b"foreign").unwrap();
    })));
    let receipt = prepared.activate(root.path());
    vault_fs::set_before_install_hook(None);
    assert!(matches!(
        receipt.unwrap(),
        RecoveryActivation::Installed { durability: Err(_) }
    ));
    assert!(prepared.deactivate(root.path()).is_err());
    assert_eq!(vault_fs::read(root.path(), live).unwrap(), b"foreign");
}

#[test]
fn prepared_recovery_activation_is_exclusive_and_keeps_the_owned_inode() {
    let root = tempfile::tempdir().unwrap();
    vault_fs::create_new_strict(
        root.path(),
        ".futo-editor-recovery/owned.prepared",
        b"header\nedit\n",
    )
    .unwrap();
    let prepared = vault_fs::prepare_recovery_activation(
        root.path(),
        ".futo-editor-recovery/owned.prepared",
        ".futo-editor-recovery/live.jsonl",
    );
    #[cfg(not(unix))]
    {
        assert!(matches!(
            prepared,
            Err(vault_fs::RecoveryPreparationError::Unsupported)
        ));
        return;
    }
    #[cfg(unix)]
    let mut prepared = prepared.unwrap();
    #[cfg(unix)]
    {
        assert!(!vault_fs::exists(root.path(), ".futo-editor-recovery/live.jsonl").unwrap());
        vault_fs::create_new(root.path(), ".futo-editor-recovery/live.jsonl", b"foreign").unwrap();
        assert!(matches!(
            prepared.activate(root.path()).unwrap(),
            RecoveryActivation::Occupied
        ));
        assert_eq!(
            vault_fs::read(root.path(), ".futo-editor-recovery/live.jsonl").unwrap(),
            b"foreign"
        );
        vault_fs::remove(root.path(), ".futo-editor-recovery/live.jsonl").unwrap();
        match prepared.activate(root.path()).unwrap() {
            RecoveryActivation::Installed { durability } => durability.unwrap(),
            RecoveryActivation::Occupied => panic!("unoccupied destination refused"),
        }
        prepared
            .verify(root.path(), ".futo-editor-recovery/live.jsonl")
            .unwrap();
        vault_fs::open_append(root.path(), ".futo-editor-recovery/owned.prepared")
            .unwrap()
            .set_len(7)
            .unwrap();
        assert_eq!(
            vault_fs::read(root.path(), ".futo-editor-recovery/live.jsonl").unwrap(),
            b"header\n"
        );
        prepared.discard(root.path()).unwrap();
        assert!(!vault_fs::exists(root.path(), ".futo-editor-recovery/owned.prepared").unwrap());
        assert_eq!(
            vault_fs::read(root.path(), ".futo-editor-recovery/live.jsonl").unwrap(),
            b"header\n"
        );
    }
}

#[cfg(unix)]
#[test]
fn installed_sync_failure_retains_effect_and_repair_never_removes_foreign_live_bytes() {
    let root = tempfile::tempdir().unwrap();
    vault_fs::create_new_strict(
        root.path(),
        ".futo-editor-recovery/owned.prepared",
        b"header\nedit\n",
    )
    .unwrap();
    let mut prepared = vault_fs::prepare_recovery_activation(
        root.path(),
        ".futo-editor-recovery/owned.prepared",
        ".futo-editor-recovery/live.jsonl",
    )
    .unwrap();
    vault_fs::fail_directory_sync_on_call(1);
    assert!(matches!(
        prepared.activate(root.path()).unwrap(),
        RecoveryActivation::Installed { durability: Err(_) }
    ));
    prepared
        .verify(root.path(), ".futo-editor-recovery/live.jsonl")
        .unwrap();
    prepared.deactivate(root.path()).unwrap();
    assert!(!vault_fs::exists(root.path(), ".futo-editor-recovery/live.jsonl").unwrap());
    vault_fs::create_new(root.path(), ".futo-editor-recovery/live.jsonl", b"foreign").unwrap();
    assert!(prepared.deactivate(root.path()).is_err());
    assert_eq!(
        vault_fs::read(root.path(), ".futo-editor-recovery/live.jsonl").unwrap(),
        b"foreign"
    );
    prepared.discard(root.path()).unwrap();
}
