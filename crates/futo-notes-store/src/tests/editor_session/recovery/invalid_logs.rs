use super::fixtures::invalidate_stream;
use super::*;

#[test]
fn torn_tail_opens_the_validated_draft_without_changing_the_damaged_log() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    {
        let mut editor = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
        disk.lock().unwrap().fault = Some(Fault::ShortWrite);
        assert!(editor.replace(Revision(1), range(6, 6), "?").is_err());
    }
    disk.lock().unwrap().fault = None;
    let before = disk.lock().unwrap().accepted.clone();
    let mut editor = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    assert_eq!(editor.source_text(), "plain!");
    assert_eq!(editor.revision(), Revision(1));
    assert!(editor.recovery_status().paused);
    assert_eq!(disk.lock().unwrap().accepted, before);
    assert!(matches!(
        editor.replace(Revision(1), range(6, 6), "?"),
        Err(EditorStoreError::RecoveryPaused)
    ));
    editor.resume_recovery().unwrap();
    editor.replace(Revision(1), range(6, 6), "?").unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "plain!?");
}

#[test]
fn corrupt_interior_retains_the_validated_prefix_and_does_not_skip_to_later_records() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    {
        let mut editor = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
        editor.replace(Revision(1), range(6, 6), "?").unwrap();
        editor.replace(Revision(2), range(7, 7), "tail").unwrap();
    }
    {
        let mut disk = disk.lock().unwrap();
        let bytes = disk.accepted.values_mut().next().unwrap();
        let index = bytes.iter().position(|byte| *byte == b'?').unwrap();
        bytes[index] = b'X';
    }
    let before = disk.lock().unwrap().accepted.clone();
    let mut editor = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    assert_eq!(editor.source_text(), "plain!");
    assert_eq!(editor.revision(), Revision(1));
    assert!(editor.recovery_status().paused);
    assert!(editor.resume_recovery().is_err());
    assert!(editor.checkpoint().is_err());
    assert_eq!(disk.lock().unwrap().accepted, before);
    assert_eq!(store.read("plain").unwrap(), "plain");
}

#[test]
fn invalid_streams_report_typed_issues_and_preserve_the_original_bytes() {
    for (case, expected_kind, expected_record, expected_source) in [
        (
            "duplicate",
            RecoveryIssueKind::SequenceMismatch,
            2,
            "plain!",
        ),
        ("invalid-edit", RecoveryIssueKind::InvalidEdit, 2, "plain!"),
        (
            "wrong-note",
            RecoveryIssueKind::IdentityMismatch,
            0,
            "plain",
        ),
        (
            "wrong-vault",
            RecoveryIssueKind::IdentityMismatch,
            0,
            "plain",
        ),
        (
            "version",
            RecoveryIssueKind::UnsupportedVersion { version: 999 },
            0,
            "plain",
        ),
        (
            "header-corruption",
            RecoveryIssueKind::CorruptRecord,
            0,
            "plain",
        ),
        (
            "blank-interior",
            RecoveryIssueKind::CorruptRecord,
            2,
            "plain!",
        ),
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "plain", "plain").unwrap();
        let disk = Arc::new(Mutex::new(Disk::default()));
        {
            let mut editor = store
                .open_editor_with_recovery("plain", storage::options(&disk))
                .unwrap();
            editor.replace(Revision(0), range(5, 5), "!").unwrap();
            editor.replace(Revision(1), range(6, 6), "?").unwrap();
        }
        {
            let mut disk = disk.lock().unwrap();
            let bytes = disk.accepted.values_mut().next().unwrap();
            invalidate_stream(case, bytes);
        }
        let before = disk.lock().unwrap().accepted.clone();
        for _ in 0..2 {
            let mut editor = store
                .open_editor_with_recovery("plain", storage::options(&disk))
                .unwrap();
            assert_eq!(editor.source_text(), expected_source, "{case}");
            assert_eq!(
                editor.recovery_issue().as_ref(),
                Some(&RecoveryIssue {
                    kind: expected_kind.clone(),
                    record: expected_record
                }),
                "{case}"
            );
            assert!(editor.recovery_status().paused, "{case}");
            assert!(
                matches!(
                    editor.resume_recovery(),
                    Err(EditorStoreError::RecoveryNeedsReview(_))
                ),
                "{case}"
            );
            assert!(
                matches!(
                    editor.checkpoint(),
                    Err(EditorStoreError::RecoveryNeedsReview(_))
                ),
                "{case}"
            );
            assert_eq!(disk.lock().unwrap().accepted, before, "{case}");
        }
        assert_eq!(store.read("plain").unwrap(), "plain");
        assert_eq!(store.snapshot().notes.len(), 1);
    }
}

#[test]
fn mismatched_disk_base_keeps_the_draft_and_uses_the_existing_persist_or_park_workflow() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    {
        let mut editor = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
    }
    store.write("plain", "peer", None).unwrap();
    let mut editor = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    assert_eq!(editor.source_text(), "plain!");
    assert_eq!(
        editor.recovery_issue().as_ref(),
        Some(&RecoveryIssue {
            kind: RecoveryIssueKind::BaseMismatch,
            record: 0
        })
    );
    let FlushDisposition::ParkedConflict { parked_id } = editor.checkpoint().unwrap().disposition
    else {
        panic!("must preserve both versions")
    };
    assert_eq!(store.read("plain").unwrap(), "peer");
    assert_eq!(store.read(&parked_id).unwrap(), "plain!");
    assert_eq!(store.snapshot().notes.len(), 2);
    assert_eq!(editor.recovery_issue().as_ref(), None);
}

#[test]
fn incompatible_unframed_log_remains_available_and_reports_its_version() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    {
        let mut editor = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
    }
    {
        let mut disk = disk.lock().unwrap();
        let bytes = disk.accepted.values_mut().next().unwrap();
        let first = bytes.split(|byte| *byte == b'\n').next().unwrap();
        let frame: serde_json::Value = serde_json::from_slice(first).unwrap();
        let mut legacy: serde_json::Value =
            serde_json::from_str(frame["payload"].as_str().unwrap()).unwrap();
        legacy["version"] = 1.into();
        *bytes = serde_json::to_vec(&legacy).unwrap();
        bytes.push(b'\n');
    }
    let before = disk.lock().unwrap().accepted.clone();
    let editor = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    assert_eq!(
        editor.recovery_issue().as_ref(),
        Some(&RecoveryIssue {
            kind: RecoveryIssueKind::UnsupportedVersion { version: 1 },
            record: 0
        })
    );
    assert!(editor.recovery_status().paused);
    assert_eq!(disk.lock().unwrap().accepted, before);
}

#[test]
fn recovery_stays_hidden_and_does_not_cross_between_isolated_vault_roots() {
    let dev_root = TestRoot::new();
    let prod_root = TestRoot::new();
    let dev = store(&dev_root);
    let prod = store(&prod_root);
    dev.create("", "plain", "dev").unwrap();
    prod.create("", "plain", "production").unwrap();
    {
        let mut editor = dev.open_editor("plain").unwrap();
        editor.replace(Revision(0), range(3, 3), "!").unwrap();
        editor.flush_recovery().unwrap();
    }
    assert_eq!(
        dev.inventory()
            .iter()
            .map(|file| file.name.as_str())
            .collect::<Vec<_>>(),
        vec!["plain.md"]
    );
    assert_eq!(dev.snapshot().notes.len(), 1);
    assert!(dev.snapshot().folders.is_empty());
    assert_eq!(
        prod.open_editor("plain").unwrap().source_text(),
        "production"
    );
    assert_eq!(dev.open_editor("plain").unwrap().source_text(), "dev!");
    assert_eq!(prod.read("plain").unwrap(), "production");
    assert_eq!(prod.inventory().len(), 1);
}
