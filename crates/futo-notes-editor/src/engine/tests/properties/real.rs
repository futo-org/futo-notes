//! The properties, read-only, on real note directories.
use super::*;

/// Read-only: the properties on every note in the directories (or `.jsonl`
/// files) named in `LINES_COMPARE`. Prints counts only, never note text.
#[test]
#[ignore = "reads note directories named in LINES_COMPARE"]
fn the_properties_hold_on_real_notes() {
    let dirs = std::env::var("LINES_COMPARE").expect("LINES_COMPARE=dir[:dir]");
    let mut random = Random::from_env();
    for dir in dirs.split(':') {
        let mut notes: Vec<String> = Vec::new();
        if dir.ends_with(".jsonl") {
            let text = std::fs::read_to_string(dir).unwrap();
            for record in text.lines() {
                let record: serde_json::Value = serde_json::from_str(record).unwrap();
                notes.push(record["body"].as_str().unwrap_or("").to_owned());
            }
        } else {
            let mut files = Vec::new();
            markdown_files(std::path::Path::new(dir), &mut files);
            notes.extend(
                files
                    .iter()
                    .filter_map(|path| std::fs::read_to_string(path).ok()),
            );
        }
        let mut lines = 0;
        for (index, original) in notes.iter().enumerate() {
            let context = format!("note {index} of {dir}");
            let mut engine = Engine::open(original);
            assert!(
                engine.source_text() == *original,
                "{context}: bytes changed on open"
            );
            lines += engine.store.len();
            check_fresh(&engine, &context);
            if original.len() <= 20_000 {
                check_positions(&engine, &context);
            }
            let mut model = Model::default();
            let mut view = View::new(engine.display_text());
            for _ in 0..8 {
                let before = lines_of(&engine);
                step(&mut engine, &mut model, &mut view, &mut random);
                check_restyled(&before, &engine, &mut view, &context);
            }
            assert!(view.text == engine.display_text(), "{context}: view change");
            check_fresh(&engine, &context);
            while engine.undo(engine.revision(), &mut ok).unwrap().is_some() {}
            assert!(engine.source_text() == *original, "{context}: undo");
        }
        println!(
            "{dir}: {} notes, {lines} lines, all five properties hold",
            notes.len()
        );
    }
}

fn markdown_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            markdown_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "md") {
            out.push(path);
        }
    }
}
