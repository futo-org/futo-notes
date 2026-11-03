//! The durable rename journal (#214): exact intents for sync, and crash
//! recovery from the vault as a crash at each step would leave it.

use std::path::Path;

use super::*;
use crate::rename_journal::{set_rename_scope, tests_support, with_rename_journal};

fn intents(root: &Path) -> Vec<(String, String)> {
    with_rename_journal(root, |journal| {
        journal
            .intents()
            .into_iter()
            .map(|intent| (intent.from, intent.to))
            .collect()
    })
    .unwrap()
}

fn scoped(root: &TestRoot) -> LocalNoteStore {
    set_rename_scope(&root.0, Some("collection")).unwrap();
    store(root)
}

fn copy_tree(from: &Path, to: &Path) {
    for entry in walkdir::WalkDir::new(from) {
        let entry = entry.unwrap();
        let target = to.join(entry.path().strip_prefix(from).unwrap());
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).unwrap();
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

/// The vault exactly as a crash just before the first step starting with
/// `step` would leave it, while `operation` itself runs to completion.
fn crash_image(root: &TestRoot, step: &'static str, operation: impl FnOnce()) -> TestRoot {
    let image = TestRoot::new();
    let (source, target) = (root.0.clone(), image.0.clone());
    let mut taken = false;
    tests_support::on_step(move |name| {
        if !taken && name.starts_with(step) {
            copy_tree(&source, &target);
            taken = true;
        }
        Ok(())
    });
    operation();
    tests_support::clear();
    image
}

fn entries(root: &Path, folder: &str) -> Vec<String> {
    let mut names = fs::read_dir(root.join(folder))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    names.sort();
    names
}

#[test]
fn a_rename_records_its_exact_collision_resolved_move_for_sync() {
    let root = TestRoot::new();
    let store = scoped(&root);
    store.write("twin", "same body", None).unwrap();
    store.write("old", "same body", None).unwrap();
    store.write("taken", "other", None).unwrap();

    let final_id = store.rename("old", "taken").unwrap().final_id.unwrap();

    assert_ne!(final_id, "taken");
    assert_eq!(
        intents(&root.0),
        vec![("old.md".to_owned(), format!("{final_id}.md"))]
    );
    assert!(!root.0.join(".local-renames").exists());
    assert!(ids_in_order(&store).iter().all(|id| !id.starts_with('.')));
}

#[test]
fn without_a_sync_scope_a_rename_keeps_no_intent() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("old", "body", None).unwrap();

    store.rename("old", "new").unwrap();

    assert!(intents(&root.0).is_empty());
    assert!(!root.0.join(".local-renames.json").exists());
}

#[test]
fn a_new_sync_scope_drops_intents_recorded_for_another() {
    let root = TestRoot::new();
    let store = scoped(&root);
    store.write("old", "body", None).unwrap();
    store.rename("old", "new").unwrap();

    set_rename_scope(&root.0, Some("another collection")).unwrap();

    assert!(intents(&root.0).is_empty());
}

#[test]
fn a_bound_object_persists_until_its_intent_is_acknowledged() {
    let root = TestRoot::new();
    let store = scoped(&root);
    store.write("old", "body", None).unwrap();
    store.rename("old", "new").unwrap();

    let transaction = with_rename_journal(&root.0, |journal| {
        let intent = journal.intents().remove(0);
        journal.bind(intent.transaction, &intent.from, "object-1");
        intent.transaction
    })
    .unwrap();
    let bound = with_rename_journal(&root.0, |journal| journal.intents()[0].object_id.clone());
    assert_eq!(bound.unwrap().as_deref(), Some("object-1"));

    with_rename_journal(&root.0, |journal| {
        journal.acknowledge(&HashSet::from([transaction]))
    })
    .unwrap();
    assert!(intents(&root.0).is_empty());
}

#[test]
fn a_crash_before_the_source_moves_leaves_the_note_and_no_intent() {
    let root = TestRoot::new();
    let store = scoped(&root);
    store.write("old", "body", None).unwrap();

    let image = crash_image(&root, "move old.md", || {
        store.rename("old", "new").unwrap();
    });
    let restarted = LocalNoteStore::new(image.0.clone());
    restarted.bootstrap().unwrap();

    assert_eq!(restarted.read("old").unwrap(), "body");
    assert!(!restarted.exists("new"));
    assert!(intents(&image.0).is_empty());
    assert!(!image.0.join(".local-renames").exists());
}

#[test]
fn a_crash_between_moves_finishes_the_rename_and_its_backlinks_on_restart() {
    let root = TestRoot::new();
    let store = scoped(&root);
    store.write("old", "body", None).unwrap();
    store.write("pointer", "see [[old]]", None).unwrap();

    let image = crash_image(&root, "move .local-renames", || {
        store.rename("old", "new").unwrap();
    });
    assert!(!image.0.join("old.md").exists() && !image.0.join("new.md").exists());
    let restarted = LocalNoteStore::new(image.0.clone());
    let listed = restarted.bootstrap().unwrap().snapshot;

    assert_eq!(restarted.read("new").unwrap(), "body");
    assert!(!restarted.exists("old"));
    assert_eq!(restarted.read("pointer").unwrap(), "see [[new]]");
    assert!(listed.notes.iter().any(|note| note.id == "new"));
    assert_eq!(
        intents(&image.0),
        vec![("old.md".to_owned(), "new.md".to_owned())]
    );
    assert!(!image.0.join(".local-renames").exists());
}

#[test]
fn a_crash_before_the_commit_record_commits_it_on_restart() {
    let root = TestRoot::new();
    let store = scoped(&root);
    store.write("old", "body", None).unwrap();

    let image = crash_image(&root, "commit", || {
        store.rename("old", "new").unwrap();
    });
    LocalNoteStore::new(image.0.clone()).bootstrap().unwrap();

    assert_eq!(
        intents(&image.0),
        vec![("old.md".to_owned(), "new.md".to_owned())]
    );
}

#[test]
fn a_case_only_rename_interrupted_between_moves_finishes_with_the_new_spelling() {
    let root = TestRoot::new();
    let store = scoped(&root);
    store.write("note", "body", None).unwrap();

    let image = crash_image(&root, "move .local-renames", || {
        store.rename("note", "Note").unwrap();
    });
    LocalNoteStore::new(image.0.clone()).bootstrap().unwrap();

    assert!(entries(&image.0, "").contains(&"Note.md".to_owned()));
    assert!(!entries(&image.0, "").contains(&"note.md".to_owned()));
    assert_eq!(
        intents(&image.0),
        vec![("note.md".to_owned(), "Note.md".to_owned())]
    );
}

#[test]
fn recovery_never_overwrites_a_newcomer_at_the_destination() {
    let root = TestRoot::new();
    let store = scoped(&root);
    store.write("old", "ours", None).unwrap();

    let image = crash_image(&root, "move .local-renames", || {
        store.rename("old", "new").unwrap();
    });
    fs::write(image.0.join("new.md"), "newcomer").unwrap();
    let restarted = LocalNoteStore::new(image.0.clone());
    let warnings = restarted.bootstrap().unwrap().warnings;

    assert_eq!(restarted.read("new").unwrap(), "newcomer");
    let recovered = intents(&image.0);
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].0, "old.md");
    let ours = recovered[0].1.trim_end_matches(".md");
    assert_ne!(ours, "new");
    assert_eq!(restarted.read(ours).unwrap(), "ours");
    assert!(warnings.iter().any(|warning| warning.contains("was taken")));
}

#[test]
fn undoing_an_unrecorded_move_never_overwrites_a_newcomer_at_the_source() {
    let root = TestRoot::new();
    let store = scoped(&root);
    store.write("old", "ours", None).unwrap();

    let image = crash_image(&root, "stage", || {
        store.rename("old", "new").unwrap();
    });
    fs::write(image.0.join("old.md"), "newcomer").unwrap();
    let restarted = LocalNoteStore::new(image.0.clone());
    restarted.bootstrap().unwrap();

    assert_eq!(restarted.read("old").unwrap(), "newcomer");
    assert!(!restarted.exists("new"));
    let ours = ids_in_order(&restarted)
        .into_iter()
        .filter(|id| id != "old")
        .collect::<Vec<_>>();
    assert_eq!(ours.len(), 1);
    assert_eq!(restarted.read(&ours[0]).unwrap(), "ours");
    assert!(intents(&image.0).is_empty());
}

#[test]
fn a_folder_rename_interrupted_between_moves_finishes_every_note_on_restart() {
    let root = TestRoot::new();
    let store = scoped(&root);
    store.write("Proj/a", "a", None).unwrap();
    store.write("Proj/b", "b", None).unwrap();

    let image = crash_image(&root, "move .local-renames", || {
        store.rename_folder("Proj", "Work").unwrap();
    });
    let restarted = LocalNoteStore::new(image.0.clone());
    restarted.bootstrap().unwrap();

    assert_eq!(restarted.read("Work/a").unwrap(), "a");
    assert_eq!(restarted.read("Work/b").unwrap(), "b");
    assert!(!image.0.join("Proj").exists());
    let mut recovered = intents(&image.0);
    recovered.sort();
    assert_eq!(
        recovered,
        vec![
            ("Proj/a.md".to_owned(), "Work/a.md".to_owned()),
            ("Proj/b.md".to_owned(), "Work/b.md".to_owned()),
        ]
    );
}

#[test]
fn deleting_a_folder_journals_each_note_it_moves_up() {
    let root = TestRoot::new();
    let store = scoped(&root);
    store.write("Proj/a", "a", None).unwrap();

    store.delete_folder("Proj").unwrap();

    assert_eq!(
        intents(&root.0),
        vec![("Proj/a.md".to_owned(), "a.md".to_owned())]
    );
}

#[test]
fn a_failed_move_rolls_every_note_back_and_keeps_no_intent() {
    let root = TestRoot::new();
    let store = scoped(&root);
    store.write("Proj/a", "a", None).unwrap();
    store.write("Proj/b", "b", None).unwrap();
    let mut placed = 0;
    tests_support::on_step(move |name| {
        if name.starts_with("move .local-renames") {
            placed += 1;
            if placed == 2 {
                return Err("injected move failure".to_owned());
            }
        }
        Ok(())
    });

    let result = store.delete_folder("Proj");
    tests_support::clear();

    assert!(result.is_err());
    assert_eq!(store.read("Proj/a").unwrap(), "a");
    assert_eq!(store.read("Proj/b").unwrap(), "b");
    assert!(!store.exists("a") && !store.exists("b"));
    assert!(intents(&root.0).is_empty());
    assert!(!root.0.join(".local-renames").exists());
}

#[test]
fn an_unknown_journal_format_stops_renames_and_is_kept_as_evidence() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("old", "body", None).unwrap();
    let future = br#"{"version":2,"transactions":[{"something":"new"}]}"#;
    fs::write(root.0.join(".local-renames.json"), future).unwrap();

    assert!(store.rename("old", "new").is_err());
    assert!(with_rename_journal(&root.0, |_| ()).is_err());
    let booted = store.bootstrap().unwrap();

    assert!(booted.snapshot.notes.iter().any(|note| note.id == "old"));
    assert!(booted
        .warnings
        .iter()
        .any(|warning| warning.contains("unsupported format")));
    assert_eq!(
        fs::read(root.0.join(".local-renames.json")).unwrap(),
        future
    );
}

#[test]
fn a_vault_migration_carries_pending_intents_to_the_new_root() {
    let root = TestRoot::new();
    let store = scoped(&root);
    store.write("old", "body", None).unwrap();
    store.rename("old", "new").unwrap();
    let destination = TestRoot::new();

    store.stage_vault_migration(&destination.0).unwrap();

    assert_eq!(
        intents(&destination.0),
        vec![("old.md".to_owned(), "new.md".to_owned())]
    );
}
