//! The comparison run: read every `.md` under the directories in
//! `LINES_COMPARE` (`:`-separated) with pulldown-cmark, as the engine reads
//! today, and with the line reader, and print each class of line whose
//! reading changed, with counts. Read-only. Every class names the spec rule
//! that predicts it; a class that names none is a reader bug.
//!
//! `cargo test -p futo-notes-editor --lib lines::compare -- --ignored --nocapture`
//! Set `LINES_COMPARE_EXAMPLES` to a file path to write up to five example
//! lines per class (private note text: keep it out of the repo).
#![allow(clippy::too_many_lines)] // A test-only report: one long table of classes.
mod classes;
mod old;
use super::*;
use classes::*;
use old::*;
use std::collections::BTreeMap;

#[derive(Default)]
struct Tally {
    lines: usize,
    notes: std::collections::BTreeSet<usize>,
    examples: Vec<String>,
}

#[derive(Default)]
struct Totals {
    notes: usize,
    lines: usize,
    changed: usize,
    info: BTreeMap<&'static str, (usize, std::collections::BTreeSet<usize>)>,
    classes: BTreeMap<String, Tally>,
}

fn compare_note(totals: &mut Totals, note: usize, label: &str, source: &str) {
    let (old, old_spans) = old_lines(source);
    let reading = Reading::new(source);
    assert_eq!(old.len(), reading.lines.len(), "line count of note {note}");
    totals.notes += 1;
    totals.lines += old.len();
    let starts = line_starts(source);
    let mut info = |name: &'static str| {
        let entry = totals.info.entry(name).or_default();
        entry.0 += 1;
        entry.1.insert(note);
    };
    let mut by_line: Vec<Vec<(OldSpan, usize, usize)>> = vec![Vec::new(); old.len()];
    let mut crossing = vec![false; old.len()];
    let images: Vec<_> = old_spans
        .iter()
        .filter(|s| s.0 == OldSpan::Image)
        .cloned()
        .collect();
    for span in &old_spans {
        if images
            .iter()
            .any(|i| i.1 <= span.1 && span.2 <= i.2 && i != span)
        {
            continue;
        }
        let first = line_of(&starts, span.1);
        let last = line_of(&starts, span.2 - 1);
        if first == last {
            by_line[first].push(*span);
        } else {
            for flag in &mut crossing[first..=last] {
                *flag = true;
            }
        }
    }
    let mut blank_run = 0;
    let mut cause: Option<String> = None;
    for (index, line) in reading.lines.iter().enumerate() {
        let text = &source[line.range.clone()];
        let before = &old[index];
        if before.continuation && !before.fenced && !before.indented_code && !before.html {
            info("Differences row 2 — a line under a line is its own line (CommonMark joined it)");
        }
        if !before.item_start && before.lists > 0 && before.paragraph && before.continuation {
            info("Differences row 4 — a plain line under a bullet is its own line");
        }
        if text.ends_with("  ") && before.paragraph {
            info("Not in version 1 — a trailing two-space hard break is spaces");
        }
        if line.kind == Kind::Blank && !before.fenced {
            blank_run += 1;
            if blank_run == 2 {
                info("Differences row 3 — a second blank line in a row shows (runs counted once)");
            }
        } else {
            blank_run = 0;
        }
        if crossing[index] && before.paragraph {
            info("Inline — a line a mark crossed into (CommonMark joined lines)");
        }
        let mut class = block_class(before, text, line, source);
        let new_fence = matches!(line.kind, Kind::Fence { .. });
        let new_edge = match line.kind {
            Kind::Fence {
                role: FenceRole::Open,
                ..
            } => Some(true),
            Kind::Fence {
                role: FenceRole::Close,
                ..
            } => Some(false),
            _ => None,
        };
        let old_edge = before.fence_edge.then_some(before.fence_open);
        if new_fence != before.fenced || new_edge != old_edge {
            if new_edge.is_some() || old_edge.is_some() {
                let edge = fence_edge_class(before, text, line, &class);
                class = match &cause {
                    Some(cause) => format!("{cause} — the lines that fence holds"),
                    None => edge,
                };
                cause.get_or_insert(class.clone());
            } else if let Some(cause) = &cause {
                class = format!("{cause} — the lines that fence holds");
            } else if !class.is_empty() {
                // A fence CommonMark ended at its container's end, with no
                // closing line: the divergence starts here.
                cause = Some(class.clone());
            }
        } else if !new_fence && !before.fenced {
            cause = None;
        } else if let Some(cause) = &cause {
            if !class.is_empty() {
                class = format!("{cause} — the lines that fence holds");
            }
        }
        let class = if class.is_empty() && !matches!(new_shape(line), Shape::Code) {
            let mut old_here = by_line[index].clone();
            let mut new_here: Vec<_> = reading.spans[index]
                .iter()
                .filter_map(|span| {
                    new_span_kind(span, source).map(|k| (k, span.range.start, span.range.end))
                })
                .collect();
            old_here.sort();
            new_here.sort();
            let hidden: Vec<_> = reading.spans[index]
                .iter()
                .map(|span| (span.kind.clone(), span.range.clone()))
                .collect();
            inline_class(source, line, &old_here, &new_here, crossing[index], &hidden)
        } else {
            class
        };
        if class.is_empty() {
            continue;
        }
        totals.changed += 1;
        let tally = totals.classes.entry(class).or_default();
        tally.lines += 1;
        tally.notes.insert(note);
        if tally.examples.len() < 5 {
            let from = index.saturating_sub(2);
            let context: Vec<_> = reading.lines[from..=index]
                .iter()
                .map(|l| format!("{:?}", &source[l.range.clone()]))
                .collect();
            tally
                .examples
                .push(format!("{label} line {index}: {}", context.join(" / ")));
        }
    }
}

fn markdown_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        if path.is_dir() {
            markdown_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "md") {
            out.push(path);
        }
    }
}

#[test]
#[ignore = "reads note directories named in LINES_COMPARE"]
fn compare_note_sets() {
    let dirs = std::env::var("LINES_COMPARE").expect("LINES_COMPARE=dir[:dir]");
    let mut report = String::new();
    let mut examples = String::new();
    for dir in dirs.split(':') {
        let mut totals = Totals::default();
        if dir.ends_with(".jsonl") {
            // One note per line, its text in `body` (the ML corpus).
            let text = std::fs::read_to_string(dir).unwrap();
            for (note, record) in text.lines().enumerate() {
                let record: serde_json::Value = serde_json::from_str(record).unwrap();
                let body = record["body"].as_str().unwrap_or("");
                let label = format!("record {note}");
                compare_note(&mut totals, note, &label, body);
            }
        } else {
            let mut files = Vec::new();
            markdown_files(std::path::Path::new(dir), &mut files);
            for (note, path) in files.iter().enumerate() {
                let Ok(source) = std::fs::read_to_string(path) else {
                    continue;
                };
                compare_note(&mut totals, note, &path.display().to_string(), &source);
            }
        }
        report.push_str(&format!(
            "\n## {dir}\n{} notes, {} lines; {} lines read differently\n\n| class | lines | notes |\n|---|---:|---:|\n",
            totals.notes, totals.lines, totals.changed
        ));
        let mut classes: Vec<_> = totals.classes.iter().collect();
        classes.sort_by_key(|(_, t)| std::cmp::Reverse(t.lines));
        for (class, tally) in &classes {
            report.push_str(&format!(
                "| {class} | {} | {} |\n",
                tally.lines,
                tally.notes.len()
            ));
            examples.push_str(&format!("\n### {class}\n"));
            for example in &tally.examples {
                examples.push_str(&format!("{example}\n"));
            }
        }
        report.push_str(
            "\nSame block, shown differently:\n\n| what | lines | notes |\n|---|---:|---:|\n",
        );
        for (name, (lines, notes)) in &totals.info {
            report.push_str(&format!("| {name} | {lines} | {} |\n", notes.len()));
        }
    }
    println!("{report}");
    if let Ok(path) = std::env::var("LINES_COMPARE_EXAMPLES") {
        std::fs::write(path, examples).unwrap();
    }
}
