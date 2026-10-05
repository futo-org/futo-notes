//! Per-mutation cost harness for the local note store (ignored; run by hand).
//!
//! Every editor autosave lands in `LocalNoteStore::save`, so its cost scales
//! the one path users hit hundreds of times a day. Builds a synthetic vault of
//! N notes across 30 folders, then times `save` of one existing note and
//! `startup_listing` / `bootstrap` for the first-frame paths.
//!
//!   cargo test -p futo-notes-store --test perf_save -- --ignored --nocapture
//!   FUTO_PERF_NOTES=10000 cargo test -p futo-notes-store --test perf_save -- --ignored --nocapture
//!
//! For a syscall count, wrap the same binary in `strace -f -c`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

use futo_notes_store::LocalNoteStore;

fn temp_vault() -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "futo-perf-save-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn seed(root: &PathBuf, notes: usize) {
    for i in 0..notes {
        let dir = root.join(format!("Area-{:02}", i % 30));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("Note {i:05}.md")),
            format!(
                "# Note {i}\n\nSome body text with a #tag-{} inside.\n",
                i % 50
            ),
        )
        .unwrap();
    }
}

fn p(sorted: &[u128], q: f64) -> f64 {
    let i = ((sorted.len() as f64 - 1.0) * q).round() as usize;
    sorted[i.min(sorted.len() - 1)] as f64 / 1000.0
}

#[test]
#[ignore]
fn save_cost_by_vault_size() {
    let notes: usize = std::env::var("FUTO_PERF_NOTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2500);
    let root = temp_vault();
    seed(&root, notes);
    let store = LocalNoteStore::new(root.clone());

    let t = Instant::now();
    let listing = store.startup_listing();
    let listing_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    let boot = store.bootstrap().unwrap();
    let boot_ms = t.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(listing.notes.len(), notes);
    assert_eq!(boot.snapshot.notes.len(), notes);

    let id = "Area-07/Note 00007";
    // Warm up.
    for i in 0..3 {
        store
            .save(Some(id), id, &format!("# warm {i}\n"), None)
            .unwrap();
    }
    let reps = 20;
    let mut saves = Vec::with_capacity(reps);
    for i in 0..reps {
        let body = format!("# Note 7\n\nedit number {i}\n");
        let t = Instant::now();
        let mutation = store.save(Some(id), id, &body, None).unwrap();
        saves.push(t.elapsed().as_micros());
        assert_eq!(mutation.upserted.len(), 1);
        assert_eq!(
            mutation.upserted[0].position, 0,
            "just-saved note is newest"
        );
    }
    saves.sort_unstable();

    // A brand-new note (the `install_new` path: unique-id allocation).
    let mut creates = Vec::with_capacity(reps);
    for i in 0..reps {
        let t = Instant::now();
        store
            .create("Area-03", &format!("Fresh {i}"), "# fresh\n")
            .unwrap();
        creates.push(t.elapsed().as_micros());
    }
    creates.sort_unstable();

    eprintln!("--- LocalNoteStore, {notes} notes / 30 folders ---");
    eprintln!("startup_listing (stat-only first frame): {listing_ms:.1} ms");
    eprintln!("bootstrap (reads every note):            {boot_ms:.1} ms");
    eprintln!(
        "save existing note: p50 {:.2} ms  p90 {:.2} ms  min {:.2} ms",
        p(&saves, 0.5),
        p(&saves, 0.9),
        p(&saves, 0.0)
    );
    eprintln!(
        "create new note:    p50 {:.2} ms  p90 {:.2} ms  min {:.2} ms",
        p(&creates, 0.5),
        p(&creates, 0.9),
        p(&creates, 0.0)
    );
    let _ = std::fs::remove_dir_all(&root);
}
