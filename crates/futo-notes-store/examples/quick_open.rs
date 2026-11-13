//! Time to first text, engine only: what a host waits on before it can show a
//! note's first screens, the whole open against the quick open.
//!
//!   cargo run --release -p futo-notes-store --example quick_open -- \
//!       [--reps N] [--note FILE]... SECTIONS...
//!
//! A note of S sections is `## Section i\n\nBody line i with **bold**.\n\n`
//! repeated (2·S blocks, the `select_all_format` note); `--note` adds a file.
//! Each repetition, in a fresh vault holding the note:
//! - `whole`: `open_editor` + `display_text`, as the Android open does before
//!   it shows anything;
//! - `quick`: `quick_open_editor`, which reads the note and parses its first 16 KB.
//!   Times are wall clock around the call, file I/O included (page cache warm).
#![allow(clippy::print_stdout)] // A developer benchmark: the report is its output.
use std::time::Instant;

use futo_notes_store::LocalNoteStore;

fn note(sections: usize) -> String {
    (0..sections)
        .map(|i| format!("## Section {i}\n\nBody line {i} with **bold**.\n\n"))
        .collect()
}

fn median(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    samples[samples.len() / 2]
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mut reps = 5usize;
    let mut notes: Vec<(String, String)> = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--reps" => reps = args.next().and_then(|v| v.parse().ok()).expect("--reps N"),
            "--note" => {
                let path = args.next().expect("--note FILE");
                let body = std::fs::read_to_string(&path).expect("read note");
                notes.push((path, body));
            }
            _ => {
                let sections: usize = arg.parse().expect("SECTIONS");
                notes.push((format!("{} blocks", sections * 2), note(sections)));
            }
        }
    }
    let root = std::env::temp_dir().join(format!("futo-quick-open-{}", std::process::id()));
    println!(
        "{:>40} {:>9} {:>11} {:>11} {:>12}",
        "note", "bytes", "whole ms", "quick ms", "quick chars"
    );
    for (name, body) in &notes {
        let (mut whole, mut quick, mut shown) = (Vec::new(), Vec::new(), 0);
        for _ in 0..reps {
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("vault");
            std::fs::write(root.join("note.md"), body).expect("write note");
            let store = LocalNoteStore::new(root.clone());

            let began = Instant::now();
            let opened = store.quick_open_editor("note").expect("quick open");
            quick.push(began.elapsed().as_secs_f64() * 1e3);
            shown = opened.map_or(0, |opened| opened.display.chars().count());

            let began = Instant::now();
            let mut session = store.open_editor("note").expect("open");
            let display = session.display_text();
            whole.push(began.elapsed().as_secs_f64() * 1e3);
            assert!(display.len() >= shown);
            session.close().expect("close");
        }
        println!(
            "{:>40} {:>9} {:>11.2} {:>11.2} {:>12}",
            name,
            body.len(),
            median(whole),
            median(quick),
            shown
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}
