//! Select-all + inline format toggle on a long clean note, through the Store's
//! editor session (the path the Android text-first editor reaches over UniFFI).
//!
//!   cargo run --release -p futo-notes-store --example select_all_format -- \
//!       [--reps N] [--format bold|italic] [--write-note DIR] SECTIONS...
//!
//! A note of S sections is `## Section i\n\nBody line i with **bold**.\n\n`
//! repeated: 2·S blocks. Each repetition opens a fresh session and times
//! select-all, toggle on, toolbar, toggle off, toolbar, Undo (back to on),
//! Undo (back to the original), and the checkpoint save after the first toggle.
//! `--write-note DIR` writes each note as `DIR/clean-<blocks>-blocks.md` and exits.
#![allow(clippy::print_stdout)] // A developer benchmark: the report is its output.
use std::time::Instant;

use futo_notes_editor::{Affinity, DisplayOffset, DisplayRange, InlineFormat};
use futo_notes_store::LocalNoteStore;

fn note(sections: usize) -> String {
    let mut s = String::with_capacity(sections * 48);
    for i in 0..sections {
        s += &format!("## Section {i}\n\nBody line {i} with **bold**.\n\n");
    }
    s
}

fn ms(ns: u128) -> f64 {
    ns as f64 / 1e6
}

fn stats(mut v: Vec<f64>) -> (f64, f64) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (v[v.len() / 2], v[v.len() - 1])
}

const STEPS: [&str; 9] = [
    "open", "select", "on", "toolbar", "save", "off", "toolbar2", "undo", "undo2",
];

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut reps, mut format, mut write_dir, mut sizes) =
        (5usize, InlineFormat::Bold, None, vec![]);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--reps" => reps = args.next().and_then(|v| v.parse().ok()).expect("--reps N"),
            "--format" => {
                format = match args.next().as_deref() {
                    Some("italic") => InlineFormat::Italic,
                    _ => InlineFormat::Bold,
                }
            }
            "--write-note" => write_dir = args.next(),
            _ => sizes.push(arg.parse::<usize>().expect("SECTIONS")),
        }
    }
    if let Some(dir) = write_dir {
        for &sections in &sizes {
            let path = format!("{dir}/clean-{}-blocks.md", sections * 2);
            std::fs::write(&path, note(sections)).expect("write note");
            println!("{path}");
        }
        return;
    }
    println!(
        "{:>8} {:>7} {:>8}  {}",
        "sections",
        "blocks",
        "bytes",
        STEPS.map(|s| format!("{s:>17}")).join("")
    );
    println!(
        "{:>26}{}",
        "",
        STEPS.map(|_| format!("{:>17}", "median/max ms")).join("")
    );
    for &sections in &sizes {
        let source = note(sections);
        let mut samples: Vec<Vec<f64>> = vec![vec![]; STEPS.len()];
        let mut detail = String::new();
        for rep in 0..reps {
            let vault = tempfile::tempdir().expect("temp vault");
            let store = LocalNoteStore::new(vault.path().to_path_buf());
            let id = store
                .create("", "bench", &source)
                .expect("create")
                .final_id
                .expect("id");
            let mut t = Vec::with_capacity(STEPS.len());
            let time = |t: &mut Vec<f64>, f: &mut dyn FnMut()| {
                let started = Instant::now();
                f();
                t.push(ms(started.elapsed().as_nanos()));
            };
            let mut session = None;
            time(&mut t, &mut || {
                session = Some(store.open_editor(&id).expect("open"))
            });
            let mut session = session.unwrap();
            let rev = |s: &futo_notes_store::StoreEditorSession<'_>| s.revision();
            let len = session.display_text().len();
            let all = DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(len),
            };
            time(&mut t, &mut || {
                session
                    .select_with_affinity(rev(&session), all, Affinity::Forward)
                    .expect("select");
            });
            let mut on_work = None;
            time(&mut t, &mut || {
                let change = session
                    .toggle_format(rev(&session), format)
                    .expect("toggle on")
                    .expect("changed");
                on_work = Some((
                    change.work,
                    change.projection.blocks.len(),
                    change.projection.text.len(),
                ));
            });
            let mut formats = vec![];
            time(&mut t, &mut || formats = session.toolbar_state().formats);
            assert!(
                formats.contains(&format),
                "toolbar shows {format:?} after toggle on"
            );
            time(&mut t, &mut || {
                session.checkpoint().expect("checkpoint");
            });
            time(&mut t, &mut || {
                session
                    .toggle_format(rev(&session), format)
                    .expect("toggle off")
                    .expect("changed");
            });
            time(&mut t, &mut || formats = session.toolbar_state().formats);
            assert!(
                !formats.contains(&format),
                "toolbar clears {format:?} after toggle off"
            );
            time(&mut t, &mut || {
                session.undo(rev(&session)).expect("undo").expect("changed");
            });
            time(&mut t, &mut || {
                session
                    .undo(rev(&session))
                    .expect("undo2")
                    .expect("changed");
            });
            assert_eq!(session.source_text(), source, "two undos restore the note");
            let saved = std::fs::read_to_string(vault.path().join("bench.md")).unwrap_or_default();
            if rep == 0 {
                let (work, blocks, bytes) = on_work.unwrap();
                let marker = if format == InlineFormat::Bold {
                    "**"
                } else {
                    "*"
                };
                let last = saved
                    .lines()
                    .rev()
                    .find(|l| l.contains("Body line"))
                    .unwrap_or("");
                detail = format!(
                    "    toggle-on work: parsed {} B, materialized {} B, link items {}; returned projection {} blocks / {} B; checkpoint file last body line: {last:?} ({})",
                    work.parsed_source_bytes,
                    work.materialized_source_bytes,
                    work.link_metadata_items,
                    blocks,
                    bytes,
                    if last.starts_with(marker) { "formatted" } else { "NOT formatted" },
                );
            }
            for (i, v) in t.into_iter().enumerate() {
                samples[i].push(v);
            }
        }
        let cells: String = samples
            .into_iter()
            .map(|v| {
                let (med, max) = stats(v);
                format!("{:>17}", format!("{med:.1}/{max:.1}"))
            })
            .collect();
        println!(
            "{sections:>8} {:>7} {:>8}  {cells}",
            sections * 2,
            source.len()
        );
        println!("{detail}");
    }
}
