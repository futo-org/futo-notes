use std::fs;

use futo_notes_ffi::{
    extract_tags, extract_wikilinks, image_extensions, make_id, make_preview, make_rich_preview,
    sanitize_title, split_id, validate_title, ConditionalWrite, CreateOutcome, FlushOutcome,
    NoteBootstrap, NoteError, NoteIdParts, NoteMetadata, NoteMutation, NoteRename, NoteSnapshot,
    NoteStore, SearchHit, TitleIssue,
};

mod support;

use support::{path_string, TempTree};

#[test]
fn deterministic_rules_are_thin_projections_of_the_canonical_model() {
    let title = "  A:/ title  ";
    assert_eq!(
        sanitize_title(title.to_owned()),
        futo_notes_model::sanitize_title(title)
    );

    let folder = "Projects/Nested";
    let clean_title = "A title";
    assert_eq!(
        make_id(folder.to_owned(), clean_title.to_owned()),
        futo_notes_model::make_id(folder, clean_title)
    );

    let note_id = "Projects/Nested/A title.md";
    let (expected_folder, expected_title) = futo_notes_model::split_id(note_id);
    let NoteIdParts { folder, title } = split_id(note_id.to_owned());
    assert_eq!(folder, expected_folder);
    assert_eq!(title, expected_title);

    let content = "# Heading\nBody with #Tag and [[Target|alias]].\n\n- item";
    assert_eq!(
        extract_tags(content.to_owned()),
        futo_notes_model::note_tags(content)
    );
    assert_eq!(
        make_preview(content.to_owned()),
        futo_notes_model::make_preview(content)
    );
    assert_eq!(
        make_rich_preview(content.to_owned()),
        futo_notes_model::make_rich_preview(content)
    );
    assert_eq!(
        extract_wikilinks(content.to_owned()),
        futo_notes_model::extract_wikilinks(content)
    );
    assert_eq!(
        image_extensions(),
        futo_notes_model::IMAGE_EXTENSIONS
            .iter()
            .map(|extension| (*extension).to_owned())
            .collect::<Vec<_>>()
    );

    let expected_issues = futo_notes_model::validate_title("bad/name.");
    let actual_issues = validate_title("bad/name.".to_owned());
    assert_eq!(actual_issues.len(), expected_issues.len());
    for (actual, expected) in actual_issues.into_iter().zip(expected_issues) {
        assert_eq!(actual.kind, expected.kind.as_str());
        assert_eq!(actual.message, expected.message);
    }
}

#[test]
fn note_store_projects_complete_workflow_results() {
    let temp = TempTree::new();
    let notes_root = temp.path("vault");
    let index_root = temp.path("index");
    let store = NoteStore::new(path_string(&notes_root));

    assert!(!notes_root.exists(), "construction must not perform I/O");

    fs::create_dir_all(&notes_root).unwrap();
    let alpha_content = "# Alpha\nBody #Tag [[Beta]]";
    fs::write(notes_root.join("alpha.md"), alpha_content).unwrap();

    let NoteBootstrap {
        snapshot,
        seeded,
        migrated,
        warnings: _,
    } = store.bootstrap(path_string(&index_root)).unwrap();
    assert_eq!(seeded, 0);
    assert_eq!(migrated, 0);
    let alpha = snapshot
        .notes
        .iter()
        .find(|note| note.id == "alpha")
        .unwrap();
    assert_eq!(alpha.title, "alpha");
    assert_eq!(alpha.folder, "");
    assert_eq!(alpha.preview, make_preview(alpha_content.to_owned()));
    assert_eq!(
        alpha.rich_preview,
        make_rich_preview(alpha_content.to_owned())
    );
    assert_eq!(alpha.tags, vec!["tag"]);

    assert_eq!(
        store.create_folder("Projects/Nested".to_owned()).unwrap(),
        "Projects/Nested"
    );
    let created = store
        .create_note(
            "Beta".to_owned(),
            "Projects".to_owned(),
            "version one".to_owned(),
        )
        .unwrap();
    assert_eq!(created.upserted.len(), 1);
    assert_eq!(created.upserted[0].id, "Projects/Beta");
    assert!(created.removed.is_empty());
    assert!(created.renamed.is_empty());
    assert!(created.warnings.is_empty());
    assert!(store.exists("Projects/Beta".to_owned()));
    assert_eq!(store.read("Projects/Beta".to_owned()), "version one");

    let written = store
        .write("Projects/Beta".to_owned(), "version two".to_owned())
        .unwrap();
    assert_eq!(written.upserted[0].id, "Projects/Beta");

    let flushed = store
        .write_if_unchanged(
            "Projects/Beta".to_owned(),
            "version two".to_owned(),
            "version three".to_owned(),
        )
        .unwrap();
    assert_eq!(flushed.outcome, FlushOutcome::Wrote);
    assert!(flushed.mutation.is_some());

    let changed = store
        .write_if_unchanged(
            "Projects/Beta".to_owned(),
            "version two".to_owned(),
            "must not win".to_owned(),
        )
        .unwrap();
    assert_eq!(changed.outcome, FlushOutcome::SkippedChanged);
    assert!(changed.mutation.is_none());
    assert_eq!(store.read("Projects/Beta".to_owned()), "version three");

    let deleted = store.delete("Projects/Beta".to_owned()).unwrap();
    assert_eq!(deleted.removed, vec!["Projects/Beta"]);
    let missing = store
        .write_if_unchanged(
            "Projects/Beta".to_owned(),
            "version three".to_owned(),
            "must not resurrect".to_owned(),
        )
        .unwrap();
    assert_eq!(missing.outcome, FlushOutcome::SkippedMissing);
    assert!(missing.mutation.is_none());

    assert_eq!(
        store
            .create_if_absent("Projects/Beta".to_owned(), "restored".to_owned())
            .unwrap(),
        CreateOutcome::Created
    );
    assert_eq!(
        store
            .create_if_absent("Projects/Beta".to_owned(), "must not overwrite".to_owned())
            .unwrap(),
        CreateOutcome::Existed
    );
    assert_eq!(store.read("Projects/Beta".to_owned()), "restored");

    let renamed = store
        .rename("Projects/Beta".to_owned(), "Projects/Gamma".to_owned())
        .unwrap();
    assert!(renamed
        .renamed
        .iter()
        .any(|rename| rename.from == "Projects/Beta" && rename.to == "Projects/Gamma"));

    let moved = store
        .move_note("Projects/Gamma".to_owned(), "Projects/Nested".to_owned())
        .unwrap();
    assert!(moved
        .renamed
        .iter()
        .any(|rename| { rename.from == "Projects/Gamma" && rename.to == "Projects/Nested/Gamma" }));

    let folder_renamed = store
        .rename_folder("Projects/Nested".to_owned(), "Archive".to_owned())
        .unwrap();
    assert!(folder_renamed
        .renamed
        .iter()
        .any(|rename| { rename.from == "Projects/Nested/Gamma" && rename.to == "Archive/Gamma" }));

    let folder_deleted = store.delete_folder("Archive".to_owned()).unwrap();
    assert!(folder_deleted
        .renamed
        .iter()
        .any(|rename| rename.from == "Archive/Gamma" && rename.to == "Gamma"));
    assert!(store.exists("Gamma".to_owned()));

    store.rescan();
    let hits = store.search("alpha".to_owned(), Some(10)).unwrap();
    assert!(hits.iter().all(|hit| hit.source == "bm25"));
    let _keyword_ready = store.keyword_ready();

    let missing_delete = store.delete("missing".to_owned()).unwrap();
    assert!(missing_delete.upserted.is_empty());
    assert!(missing_delete.removed.is_empty());
    assert!(missing_delete.renamed.is_empty());

    store.reset().unwrap();
    let after_reset = store.scan();
    assert!(after_reset.notes.is_empty());
    assert!(after_reset.folders.is_empty());
    assert!(notes_root.is_dir(), "reset must preserve the vault root");
}

#[test]
fn note_records_errors_and_threading_keep_the_full_semantic_shape() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<NoteStore>();

    let metadata = NoteMetadata {
        id: "folder/note.md".to_owned(),
        title: "note".to_owned(),
        folder: "folder".to_owned(),
        modified_ms: 42,
        preview: "preview".to_owned(),
        rich_preview: "rich".to_owned(),
        tags: vec!["tag".to_owned()],
    };
    let NoteMetadata {
        id,
        title,
        folder,
        modified_ms,
        preview,
        rich_preview,
        tags,
    } = metadata;
    assert_eq!(
        (id, title, folder, modified_ms, preview, rich_preview, tags),
        (
            "folder/note.md".to_owned(),
            "note".to_owned(),
            "folder".to_owned(),
            42,
            "preview".to_owned(),
            "rich".to_owned(),
            vec!["tag".to_owned()]
        )
    );

    let NoteSnapshot { notes, folders } = NoteSnapshot {
        notes: Vec::new(),
        folders: vec!["folder".to_owned()],
    };
    assert!(notes.is_empty());
    assert_eq!(folders, vec!["folder"]);

    let NoteRename { from, to } = NoteRename {
        from: "before.md".to_owned(),
        to: "after.md".to_owned(),
    };
    assert_eq!((from.as_str(), to.as_str()), ("before.md", "after.md"));

    let NoteMutation {
        upserted,
        removed,
        renamed,
        warnings,
    } = NoteMutation {
        upserted: Vec::new(),
        removed: vec!["before.md".to_owned()],
        renamed: Vec::new(),
        warnings: vec!["warning".to_owned()],
    };
    assert!(upserted.is_empty());
    assert_eq!(removed, vec!["before.md"]);
    assert!(renamed.is_empty());
    assert_eq!(warnings, vec!["warning"]);

    let NoteBootstrap {
        snapshot,
        seeded,
        migrated,
        warnings,
    } = NoteBootstrap {
        snapshot: NoteSnapshot {
            notes: Vec::new(),
            folders: Vec::new(),
        },
        seeded: 1,
        migrated: 2,
        warnings: vec!["warning".to_owned()],
    };
    assert!(snapshot.notes.is_empty());
    assert_eq!(
        (seeded, migrated, warnings),
        (1, 2, vec!["warning".to_owned()])
    );

    let ConditionalWrite { outcome, mutation } = ConditionalWrite {
        outcome: FlushOutcome::SkippedMissing,
        mutation: None,
    };
    assert_eq!(outcome, FlushOutcome::SkippedMissing);
    assert!(mutation.is_none());

    let TitleIssue { kind, message } = TitleIssue {
        kind: "empty".to_owned(),
        message: "message".to_owned(),
    };
    assert_eq!((kind.as_str(), message.as_str()), ("empty", "message"));

    let SearchHit {
        note_id,
        score,
        source,
    } = SearchHit {
        note_id: "note.md".to_owned(),
        score: 1.25,
        source: "bm25".to_owned(),
    };
    assert_eq!(
        (note_id.as_str(), score, source.as_str()),
        ("note.md", 1.25, "bm25")
    );

    assert!(matches!(NoteError::Io("io".to_owned()), NoteError::Io(_)));
    assert_eq!(NoteError::Io("io".to_owned()).to_string(), "io");
    assert_eq!(CreateOutcome::Created, CreateOutcome::Created);
    assert_eq!(CreateOutcome::Existed, CreateOutcome::Existed);
    assert_eq!(FlushOutcome::Wrote, FlushOutcome::Wrote);
    assert_eq!(FlushOutcome::SkippedChanged, FlushOutcome::SkippedChanged);
}
