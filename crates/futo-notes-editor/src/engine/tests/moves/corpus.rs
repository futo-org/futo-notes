//! The notes the engine and Linedown fixtures hold, decoded as each
//! fixture's own test reads it, for properties that run over every note.
use super::NOTE;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// How a fixture file marks the selection in its notes.
enum Marks {
    /// Linedown inputs and Find notes: none.
    None,
    /// `blocks.json`: a `|` caret, else a selection from the first `[` to
    /// the last `]`.
    CaretOrBrackets,
    /// `fences.json` and the clipboard files: each case's `marks` (caret,
    /// start, end; `|[]` when it names none), every occurrence a mark.
    PerCase,
    /// The rest: `‸`, `«` `»` and `⟦` `⟧`.
    Typographic,
}

fn marks_of(path: &Path) -> Marks {
    let name = path.file_name().unwrap().to_str().unwrap();
    let dir = path
        .parent()
        .unwrap()
        .file_name()
        .unwrap()
        .to_str()
        .unwrap();
    match (dir, name) {
        ("linedown", _) | (_, "find.json") => Marks::None,
        (_, "blocks.json") => Marks::CaretOrBrackets,
        ("clipboard", _) | (_, "fences.json") => Marks::PerCase,
        _ => Marks::Typographic,
    }
}

fn decode(note: &str, marks: &Marks, case_marks: Option<&str>) -> String {
    match marks {
        Marks::None => note.to_owned(),
        Marks::CaretOrBrackets => match note.find('|') {
            Some(_) => note.replacen('|', "", 1),
            None => match (note.find('['), note.rfind(']')) {
                (Some(start), Some(end)) if start < end => {
                    let mut text = note.to_owned();
                    text.remove(end);
                    text.remove(start);
                    text
                }
                _ => note.to_owned(),
            },
        },
        Marks::PerCase => {
            let marks = case_marks.unwrap_or("|[]");
            note.chars().filter(|ch| !marks.contains(*ch)).collect()
        }
        Marks::Typographic => note
            .chars()
            .filter(|ch| !matches!(ch, '‸' | '«' | '»' | '⟦' | '⟧'))
            .collect(),
    }
}

fn walk(value: &Value, marks: &Marks, notes: &mut Vec<String>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| walk(item, marks, notes)),
        Value::Object(fields) => {
            let case_marks = fields.get("marks").and_then(Value::as_str);
            for (key, field) in fields {
                match field.as_str() {
                    Some(note) if matches!(key.as_str(), "input" | "before" | "after") => {
                        notes.push(decode(note, marks, case_marks));
                    }
                    _ => walk(field, marks, notes),
                }
            }
        }
        _ => {}
    }
}

fn files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "json") {
            out.push(path);
        }
    }
}

/// Every note under `tests/fixtures/`, decoded, with the move tests' own.
pub(super) fn fixture_notes() -> Vec<String> {
    let mut paths = Vec::new();
    files(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures"),
        &mut paths,
    );
    assert!(paths.len() > 20, "fixtures not found: {paths:?}");
    let mut notes = vec![NOTE.to_owned(), "a\nb\n- [ ] ".to_owned()];
    for path in paths {
        let file = std::fs::read_to_string(&path).unwrap();
        walk(
            &serde_json::from_str(&file).unwrap(),
            &marks_of(&path),
            &mut notes,
        );
    }
    notes.sort();
    notes.dedup();
    notes
}
