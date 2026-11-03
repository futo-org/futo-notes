//! Engine keystroke benchmark: the keys the Android text-first editor sends
//! (type, Enter, Backspace at a line end near the middle of the note), timed
//! on this machine, with the engine's own work counters and projection size.
//!
//!   cargo run --release -p futo-notes-store --example editor_keys -- \
//!       [--store] [--keys N] [--json out.json] [--baseline old.json] [FIXTURE...]
//!
//! A FIXTURE is a Markdown file or `synthetic:<shape>` (see `SHAPES`); none
//! means every synthetic shape. Synthetic notes reproduce the corpus shapes
//! that are slow on the phone, so CI can run without the corpus.
//! `--store` goes through the Store's editor session (in-memory edits and debounced saves)
//! instead of the bare engine.
#![allow(clippy::print_stdout)] // A developer benchmark: the report is its output.
use std::path::Path;
use std::time::Instant;

use futo_notes_editor::{
    DisplayOffset, DisplayRange, EditorSession, InputAction, ParagraphKey, ViewChange,
};
use futo_notes_store::{LocalNoteStore, StoreEditorSession};
use serde_json::{json, Value};

type Shape = (&'static str, fn() -> String);

const SHAPES: [Shape; 8] = [
    ("small", small),
    ("long-paragraph", long_paragraph),
    ("nested-list-links", nested_list_links),
    ("numbered-nested", numbered_nested),
    ("table", table),
    ("huge-fence", huge_fence),
    ("huge-mixed", huge_mixed),
    ("tight-list", tight_list),
];

/// Deterministic words so every run and machine sees the same notes.
struct Words(u64);
impl Words {
    fn next(&mut self) -> &'static str {
        const WORDS: [&str; 16] = [
            "the",
            "duck",
            "eggs",
            "usually",
            "take",
            "days",
            "to",
            "hatch",
            "but",
            "some",
            "breeds",
            "incubator",
            "prepared",
            "advance",
            "before",
            "attempt",
        ];
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        WORDS[(self.0 >> 60) as usize]
    }
    fn sentence(&mut self, words: usize) -> String {
        (0..words)
            .map(|_| self.next())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn small() -> String {
    let mut w = Words(1);
    format!(
        "# Groceries\n\n{}.\n\n- milk\n- **eggs** for {}\n- [bread](https://example.com/bread)\n\n## Later\n\n{}.\n\n1. call the store\n2. {}\n\n> {}\n",
        w.sentence(40),
        w.sentence(4),
        w.sentence(60),
        w.sentence(6),
        w.sentence(20),
    )
}

/// One 11k-char line (corpus random-882329).
fn long_paragraph() -> String {
    let mut w = Words(2);
    let mut s = String::new();
    while s.len() < 11_300 {
        s += &w.sentence(12);
        s += " , ";
        s += &w.sentence(8);
        s += " . ";
    }
    s
}

/// 3,400 lines of bullets nested up to 7 deep, links and headings inside
/// items (corpus longest-list-af5ebc).
fn nested_list_links() -> String {
    let mut w = Words(3);
    let mut s = String::new();
    for i in 0..3_400usize {
        let depth = [0, 1, 2, 3, 4, 5, 6, 5, 6, 4, 5, 3][i % 12];
        let indent = "    ".repeat(depth);
        match i % 7 {
            0 => s += &format!("{indent}- ### Encounters {i}\n"),
            1 | 4 => {
                let name = w.sentence(2);
                s += &format!(
                    "{indent}- 1d4 [{name}](https://www.example.com/monsters/{}-{i})s\n",
                    name.replace(' ', "-")
                )
            }
            2 => s += &format!("{indent}- **d100**\n"),
            _ => s += &format!("{indent}- {:02}–{:02}\n", i % 100, (i + 2) % 100),
        }
    }
    s
}

/// A numbered list with nested numbered items and links (corpus 6ae4d2).
fn numbered_nested() -> String {
    let mut w = Words(4);
    let mut s = String::from("## Instructions\n\n");
    for i in 1..=40 {
        s += &format!("{i}. {} [link](https://example.com/{i})\n", w.sentence(6));
        for j in 1..=3 {
            s += &format!("      {j}. {} `code`\n", w.sentence(5));
        }
    }
    s
}

/// A 200-row, 3-column table of URLs, ~30k chars (corpus biggest-table-06a6e2).
fn table() -> String {
    let mut w = Words(5);
    let mut s = String::from("# Second-Brain\n\nA curated list.\n\n| Name | Second Brain | Twitter |\n| --- | --- | --- |\n");
    for i in 0..200 {
        let name = w.sentence(2);
        s += &format!(
            "| {name:<21} | https://{}.example.com/notes/{i:<40} | https://twitter.com/{:<20} |\n",
            name.replace(' ', ""),
            name.replace(' ', "_")
        );
    }
    s
}

/// A 4,000-line fenced block of 128-char lines (corpus most-bytes-f76ca6).
fn huge_fence() -> String {
    let mut s = String::from("# Excalidraw Data\n\n## Drawing\n```compressed-json\n");
    let mut x = 7u64;
    for _ in 0..4_000 {
        for _ in 0..128 {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            s.push(
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
                    [(x >> 58) as usize] as char,
            );
        }
        s.push('\n');
    }
    s += "```\n%%\n";
    s
}

/// 19k lines, ~320k chars of everyday Markdown (corpus most-lines-4b72d2).
fn huge_mixed() -> String {
    let mut w = Words(6);
    let mut s = String::new();
    let mut i = 0usize;
    while s.lines().count() < 19_000 && s.len() < 330_000 {
        s += &format!("## Day {i}\n\n");
        s += &format!(
            "- {} [[note {i}]]\n- **{}** item\n- {}\n\n",
            w.sentence(3),
            w.sentence(2),
            w.sentence(4)
        );
        s += &format!("{}\n", w.sentence(4));
        i += 1;
    }
    s
}

/// 5,000 one-line bullets (the long_regions.rs shape, a known-local baseline).
fn tight_list() -> String {
    (0..5_000).map(|i| format!("- item {i}\n")).collect()
}

/// Either engine path; both take and return display byte ranges.
enum Keys<'a> {
    Engine(EditorSession),
    Store(Box<StoreEditorSession<'a>>),
}

#[derive(Clone, Copy)]
enum Action {
    Type,
    Enter,
    Backspace,
}

enum Outcome {
    Changed(Box<ViewChange>),
    /// The engine accepted the key and changed nothing (e.g. Backspace at the start).
    NoOp,
    Refused(String),
}

impl Keys<'_> {
    fn display(&self) -> String {
        match self {
            Keys::Engine(s) => s.display_text(),
            Keys::Store(s) => s.display_text(),
        }
    }

    fn key(&mut self, at: DisplayRange, action: Action) -> Outcome {
        let result = match self {
            Keys::Engine(s) => {
                let rev = s.revision();
                let accept = &mut |_: &_| Ok(());
                match action {
                    Action::Type => s
                        .replace_action(rev, at, "a", InputAction::Typing, accept)
                        .map(Some),
                    Action::Enter => s.paragraph_key(rev, at, ParagraphKey::Enter, accept),
                    Action::Backspace => s.paragraph_key(rev, at, ParagraphKey::Backspace, accept),
                }
                .map_err(|e| format!("{e:?}"))
            }
            Keys::Store(s) => {
                let rev = s.revision();
                match action {
                    Action::Type => s
                        .replace_action(rev, at, "a", InputAction::Typing)
                        .map(Some),
                    Action::Enter | Action::Backspace => {
                        let key = if matches!(action, Action::Enter) {
                            ParagraphKey::Enter
                        } else {
                            ParagraphKey::Backspace
                        };
                        s.display_to_utf16(rev, at)
                            .and_then(|range| s.paragraph_key_utf16(rev, range, key))
                    }
                }
                .map_err(|e| format!("{e:?}"))
            }
        };
        match result {
            Ok(Some(change)) => Outcome::Changed(Box::new(change)),
            Ok(None) => Outcome::NoOp,
            Err(e) => Outcome::Refused(e),
        }
    }
}

fn caret(at: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    }
}

fn percentile(sorted: &[u64], q: usize) -> u64 {
    sorted[((sorted.len() - 1) * q + 50) / 100]
}

fn measure(label: &str, source: &str, use_store: bool, keys: usize) -> Value {
    let vault = tempfile::tempdir().expect("temp vault");
    let store = LocalNoteStore::new(vault.path().to_path_buf());
    let opened = Instant::now();
    let mut session = if use_store {
        let id = store
            .create("", "bench", source)
            .expect("create")
            .final_id
            .expect("id");
        Keys::Store(Box::new(store.open_editor(&id).expect("open")))
    } else {
        Keys::Engine(EditorSession::open(source))
    };
    let open_ns = opened.elapsed().as_nanos() as u64;
    // The end of the line nearest the middle, as the phone benchmark does.
    let display = session.display();
    let mut at = display[display.len() / 2..]
        .find('\n')
        .map_or(display.len(), |i| display.len() / 2 + i);
    for _ in 0..5 {
        if let Outcome::Changed(change) = session.key(caret(at), Action::Type) {
            at = change.selection.end.0;
        }
    }
    let mut series = |action: Action, count: usize, at: &mut usize| -> Value {
        let mut times = Vec::with_capacity(count);
        let (mut parsed, mut materialized, mut link_items, mut blocks, mut projected) =
            (vec![], vec![], vec![], vec![], vec![]);
        let (mut refused, mut noop) = (0, 0);
        let mut first_refusal = None;
        for _ in 0..count {
            let started = Instant::now();
            let outcome = session.key(caret(*at), action);
            let elapsed = started.elapsed().as_nanos() as u64;
            match outcome {
                Outcome::Changed(change) => {
                    times.push(elapsed);
                    parsed.push(change.work.parsed_source_bytes as u64);
                    materialized.push(change.work.materialized_source_bytes as u64);
                    link_items.push(change.work.link_metadata_items as u64);
                    blocks.push(change.projection.blocks.len() as u64);
                    projected.push(
                        (change.projection.range.end.0 - change.projection.range.start.0) as u64,
                    );
                    *at = change.selection.end.0;
                }
                Outcome::NoOp => noop += 1,
                Outcome::Refused(e) => {
                    refused += 1;
                    first_refusal.get_or_insert(e);
                }
            }
        }
        let name = match action {
            Action::Type => "type",
            Action::Enter => "enter",
            Action::Backspace => "backspace",
        };
        let mut result =
            json!({ "action": name, "samples": times.len(), "refused": refused, "noop": noop });
        if let Some(e) = first_refusal {
            result["refusal"] = json!(e);
        }
        if times.is_empty() {
            return result;
        }
        let p50 = |v: &mut Vec<u64>| {
            v.sort_unstable();
            percentile(v, 50)
        };
        times.sort_unstable();
        result["p50Ns"] = json!(percentile(&times, 50));
        result["p95Ns"] = json!(percentile(&times, 95));
        result["maxNs"] = json!(times[times.len() - 1]);
        result["work"] = json!({
            "parsedBytes": p50(&mut parsed),
            "materializedBytes": p50(&mut materialized),
            "linkItems": p50(&mut link_items),
            "projectionBlocks": p50(&mut blocks),
            "projectionBytes": p50(&mut projected),
        });
        result
    };
    let actions = vec![
        series(Action::Type, keys, &mut at),
        series(Action::Enter, keys, &mut at),
        series(Action::Backspace, keys, &mut at),
    ];
    json!({ "label": label, "bytes": source.len(), "openNs": open_ns, "actions": actions })
}

fn ms(ns: u64) -> String {
    format!("{:7.2}", ns as f64 / 1e6)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut use_store, mut keys, mut json_out, mut baseline, mut fixtures) =
        (false, 30usize, None, None, vec![]);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--store" => use_store = true,
            "--keys" => keys = args.next().and_then(|v| v.parse().ok()).expect("--keys N"),
            "--json" => json_out = args.next(),
            "--baseline" => baseline = args.next(),
            _ => fixtures.push(arg),
        }
    }
    if fixtures.is_empty() {
        fixtures = SHAPES
            .iter()
            .map(|(name, _)| format!("synthetic:{name}"))
            .collect();
    }
    let baseline: Option<Value> = baseline.map(|path| {
        serde_json::from_str(&std::fs::read_to_string(path).expect("read baseline"))
            .expect("baseline json")
    });
    let mut notes = vec![];
    println!(
        "{:<28} {:>8} {:>9}  {:<9} {:>7} {:>7} {:>7}  {:>9} {:>9} {:>8} {:>6}  {}",
        "note",
        "bytes",
        "open ms",
        "action",
        "p50",
        "p95",
        "max",
        "parsed",
        "material",
        "links",
        "blocks",
        if baseline.is_some() {
            "p50 vs baseline"
        } else {
            ""
        }
    );
    for fixture in &fixtures {
        let (label, source) = match fixture.strip_prefix("synthetic:") {
            Some(name) => {
                let (_, make) = SHAPES
                    .iter()
                    .find(|(n, _)| *n == name)
                    .unwrap_or_else(|| panic!("no shape {name}"));
                (name.to_owned(), make())
            }
            None => (
                Path::new(fixture)
                    .file_stem()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                std::fs::read_to_string(fixture).expect("read fixture"),
            ),
        };
        let note = measure(&label, &source, use_store, keys);
        let before = baseline.as_ref().and_then(|b| {
            b["notes"]
                .as_array()?
                .iter()
                .find(|n| n["label"] == note["label"])
                .cloned()
        });
        for (i, a) in note["actions"].as_array().unwrap().iter().enumerate() {
            let head = if i == 0 {
                format!(
                    "{:<28} {:>8} {}  ",
                    label,
                    source.len(),
                    ms(note["openNs"].as_u64().unwrap()).trim_start().to_owned() + "  "
                )
            } else {
                " ".repeat(28 + 1 + 8 + 1 + 9 + 2)
            };
            let head = format!("{head:<50}");
            let refused = a["refused"].as_u64().unwrap();
            let Some(p50) = a["p50Ns"].as_u64() else {
                println!(
                    "{head}{:<9} no changes; refused {refused}: {}",
                    a["action"].as_str().unwrap(),
                    a["refusal"]
                );
                continue;
            };
            let work = &a["work"];
            let vs = before
                .as_ref()
                .and_then(|b| {
                    b["actions"]
                        .as_array()?
                        .iter()
                        .find(|x| x["action"] == a["action"])?["p50Ns"]
                        .as_u64()
                })
                .map(|old| {
                    format!(
                        "{:+.0}% (was {} ms)",
                        (p50 as f64 / old as f64 - 1.0) * 100.0,
                        ms(old).trim()
                    )
                })
                .unwrap_or_default();
            println!(
                "{head}{:<9} {} {} {}  {:>9} {:>9} {:>8} {:>6}  {}{}",
                a["action"].as_str().unwrap(),
                ms(p50),
                ms(a["p95Ns"].as_u64().unwrap()),
                ms(a["maxNs"].as_u64().unwrap()),
                work["parsedBytes"],
                work["materializedBytes"],
                work["linkItems"],
                work["projectionBlocks"],
                vs,
                if refused > 0 {
                    format!(" refused {refused}")
                } else {
                    String::new()
                },
            );
        }
        notes.push(note);
    }
    if let Some(path) = json_out {
        let report = json!({
            "formatVersion": 1,
            "mode": if use_store { "store" } else { "engine" },
            "keys": keys,
            "notes": notes,
        });
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap()).expect("write json");
    }
}
