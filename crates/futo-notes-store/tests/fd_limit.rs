//! A vault open's descriptors scale with threads, not with how wide the vault
//! is: iOS apps run under a 256-descriptor soft limit, and a walk that opened
//! every subfolder at once would drop folders on a folder-per-day journal.
//! Its own test binary, because it lowers RLIMIT_NOFILE for the whole process.
#![cfg(unix)]

use std::fs;

use futo_notes_store::LocalNoteStore;
use rustix::process::{getrlimit, setrlimit, Resource, Rlimit};

#[test]
fn wide_vaults_open_completely_under_a_low_descriptor_limit() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    for day in 0..400 {
        let folder = root.join(format!("Journal/Day {day:03}"));
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("entry.md"), "#journal").unwrap();
    }
    // Crash recovery also scans hidden folders.
    for bucket in 0..300 {
        fs::create_dir_all(root.join(format!(".git/objects/{bucket:02x}"))).unwrap();
    }
    let parked = root.join(".git/objects/ff");
    fs::write(parked.join(".sf-bak-1-2-3"), "parked body").unwrap();
    fs::write(parked.join(".sf-bak-1-2-3.path"), "restored.md").unwrap();

    // A phone's worth of threads, so the budget holds on any machine.
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(8)
        .build()
        .unwrap();
    let original = getrlimit(Resource::Nofile);
    let low = Rlimit {
        current: Some(64),
        maximum: original.maximum,
    };
    setrlimit(Resource::Nofile, low).unwrap();
    let (boot, listing) = pool.install(|| {
        let store = LocalNoteStore::new(root.to_owned());
        (store.bootstrap().unwrap(), store.startup_listing())
    });
    setrlimit(Resource::Nofile, original).unwrap();

    assert_eq!(boot.snapshot.notes.len(), 400);
    assert_eq!(listing.notes.len(), 400);
    assert!(parked.join("restored.md").is_file());
}
