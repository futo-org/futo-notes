use std::fs;

use futo_notes_ffi::{
    extract_tags, extract_wikilinks, image_extensions, make_id, make_preview, make_rich_preview,
    sanitize_title, split_id, validate_title, ConditionalWrite, CreateOutcome, FlushDisposition,
    FlushDraftResult, FlushOutcome, NoteBootstrap, NoteError, NoteIdParts, NoteMetadata,
    NoteMutation, NoteSnapshot, NoteStore, SearchHit, TitleIssue,
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

    let folder_created = store.create_folder("Projects/Nested".to_owned()).unwrap();
    assert_eq!(folder_created.folders, ["Projects", "Projects/Nested"]);
    let created = store
        .create_note(
            "Beta".to_owned(),
            "Projects".to_owned(),
            "version one".to_owned(),
        )
        .unwrap();
    assert_eq!(created.upserted.len(), 1);
    assert_eq!(created.upserted[0].note.id, "Projects/Beta");
    assert_eq!(created.final_id.as_deref(), Some("Projects/Beta"));
    assert!(created.removed.is_empty());
    assert_eq!(created.folders, ["Projects", "Projects/Nested"]);
    assert!(created.warnings.is_empty());
    assert!(store.exists("Projects/Beta".to_owned()));
    assert_eq!(store.read("Projects/Beta".to_owned()), "version one");

    let written = store
        .write("Projects/Beta".to_owned(), "version two".to_owned())
        .unwrap();
    assert_eq!(written.upserted[0].note.id, "Projects/Beta");
    assert_eq!(written.final_id.as_deref(), Some("Projects/Beta"));

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
    assert_eq!(renamed.removed, ["Projects/Beta"]);
    assert_eq!(renamed.final_id.as_deref(), Some("Projects/Gamma"));

    let moved = store
        .move_note("Projects/Gamma".to_owned(), "Projects/Nested".to_owned())
        .unwrap();
    assert_eq!(moved.removed, ["Projects/Gamma"]);
    assert_eq!(moved.final_id.as_deref(), Some("Projects/Nested/Gamma"));

    let folder_renamed = store
        .rename_folder("Projects/Nested".to_owned(), "Archive".to_owned())
        .unwrap();
    assert_eq!(folder_renamed.removed, ["Projects/Nested/Gamma"]);
    assert_eq!(folder_renamed.folders, ["Archive", "Projects"]);

    let folder_deleted = store.delete_folder("Archive".to_owned()).unwrap();
    assert_eq!(folder_deleted.removed, ["Archive/Gamma"]);
    assert_eq!(folder_deleted.folders, ["Projects"]);
    assert!(store.exists("Gamma".to_owned()));

    let missing_delete = store.delete("missing".to_owned()).unwrap();
    assert!(missing_delete.upserted.is_empty());
    assert!(missing_delete.removed.is_empty());
    assert_eq!(missing_delete.folders, ["Projects"]);

    store.reset().unwrap();
    let after_reset = store.scan();
    assert!(after_reset.notes.is_empty());
    assert!(after_reset.folders.is_empty());
    assert!(notes_root.is_dir(), "reset must preserve the vault root");
}

// The one draft-saving verb (persist-or-park, issue #37) projects all four
// flush dispositions and their mutations through the FFI.
#[test]
fn flush_draft_projects_every_disposition() {
    let temp = TempTree::new();
    let notes_root = temp.path("vault");
    fs::create_dir_all(&notes_root).unwrap();
    let store = NoteStore::new(path_string(&notes_root));

    fs::write(notes_root.join("note.md"), "base").unwrap();
    let wrote = store
        .flush_draft("note".to_owned(), "base".to_owned(), "draft".to_owned())
        .unwrap();
    assert_eq!(wrote.disposition, FlushDisposition::Wrote);
    let mutation = wrote.mutation.expect("a write projects a mutation");
    assert_eq!(mutation.final_id.as_deref(), Some("note"));
    assert_eq!(store.read("note".to_owned()), "draft");

    let converged = store
        .flush_draft("note".to_owned(), "stale".to_owned(), "draft".to_owned())
        .unwrap();
    assert_eq!(converged.disposition, FlushDisposition::Converged);
    assert!(converged.mutation.is_none());

    let parked = store
        .flush_draft("note".to_owned(), "stale".to_owned(), "diverged".to_owned())
        .unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = parked.disposition else {
        panic!("expected the diverged draft to be parked");
    };
    assert!(parked_id.starts_with("note (conflict "));
    assert_eq!(store.read(parked_id.clone()), "diverged");
    assert_eq!(store.read("note".to_owned()), "draft", "diverged note untouched");
    assert!(parked.mutation.is_some(), "a fresh park projects a mutation");

    // Park idempotency across the FFI: the identical draft reports the same
    // copy and mints nothing new.
    let reparked = store
        .flush_draft("note".to_owned(), "stale".to_owned(), "diverged".to_owned())
        .unwrap();
    assert_eq!(
        reparked.disposition,
        FlushDisposition::ParkedConflict { parked_id }
    );
    assert!(reparked.mutation.is_none());

    store.delete("note".to_owned()).unwrap();
    let recreated = store
        .flush_draft("note".to_owned(), "draft".to_owned(), "survivor".to_owned())
        .unwrap();
    assert_eq!(recreated.disposition, FlushDisposition::Recreated);
    let mutation = recreated.mutation.expect("a recreate projects a mutation");
    assert_eq!(mutation.final_id.as_deref(), Some("note"));
    assert_eq!(mutation.upserted[0].position, 0);
    assert_eq!(store.read("note".to_owned()), "survivor");
}

#[test]
fn bootstrap_makes_existing_note_content_searchable_through_bm25() {
    let temp = TempTree::new();
    let notes_root = temp.path("vault");
    let index_root = temp.path("index");

    fs::create_dir_all(&notes_root).unwrap();
    fs::write(
        notes_root.join("alpha.md"),
        "# Alpha\nuniquebootstrapkeyword",
    )
    .unwrap();

    let store = NoteStore::new(path_string(&notes_root));
    store.bootstrap(path_string(&index_root)).unwrap();

    assert!(
        store.wait_until_search_ready(10_000),
        "keyword index never became ready"
    );

    let hits = store
        .search("uniquebootstrapkeyword".to_owned(), Some(10))
        .unwrap();
    assert!(
        hits.iter()
            .any(|hit| hit.note_id == "alpha" && hit.source == "bm25"),
        "expected alpha BM25 hit"
    );
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

    let NoteMutation {
        upserted,
        removed,
        folders,
        final_id,
        warnings,
    } = NoteMutation {
        upserted: Vec::new(),
        removed: vec!["before.md".to_owned()],
        folders: vec!["folder".to_owned()],
        final_id: Some("after.md".to_owned()),
        warnings: vec!["warning".to_owned()],
    };
    assert!(upserted.is_empty());
    assert_eq!(removed, vec!["before.md"]);
    assert_eq!(folders, vec!["folder"]);
    assert_eq!(final_id.as_deref(), Some("after.md"));
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

    let FlushDraftResult {
        disposition,
        mutation,
    } = FlushDraftResult {
        disposition: FlushDisposition::ParkedConflict {
            parked_id: "note (conflict 2026-07-21)".to_owned(),
        },
        mutation: None,
    };
    assert_eq!(
        disposition,
        FlushDisposition::ParkedConflict {
            parked_id: "note (conflict 2026-07-21)".to_owned()
        }
    );
    assert!(mutation.is_none());
    assert_eq!(FlushDisposition::Wrote, FlushDisposition::Wrote);
    assert_eq!(FlushDisposition::Converged, FlushDisposition::Converged);
    assert_eq!(FlushDisposition::Recreated, FlushDisposition::Recreated);

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
