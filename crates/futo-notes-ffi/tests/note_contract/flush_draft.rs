//! The flush verb's four dispositions, projected through the FFI.

use std::fs;

use futo_notes_ffi::{FlushDisposition, NoteStore};

use crate::support::{path_string, TempTree};

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
    assert_eq!(store.read("note".to_owned()).unwrap(), "draft");

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
    assert_eq!(store.read(parked_id.clone()).unwrap(), "diverged");
    assert_eq!(
        store.read("note".to_owned()).unwrap(),
        "draft",
        "diverged note untouched"
    );
    assert!(
        parked.mutation.is_some(),
        "a fresh park projects a mutation"
    );

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
    assert_eq!(store.read("note".to_owned()).unwrap(), "survivor");
}
