//! Copy, cut and paste: the literal cases in
//! `tests/fixtures/engine/clipboard/`; carried formats (`formats.rs`) and
//! the rules a table cannot show (`rules.rs`).
//!
//! Each case marks the selection in its source with `|` (a caret) or `[`
//! and `]` (`marks` names other characters when the note needs these), runs
//! `copy`, `cut`, `paste` (of `text`) or a plain line's `Enter` or
//! `ShiftEnter` there, and states the source and
//! selection after it, and what `copy` and `cut` copied. Every case that
//! changes the note also checks the view change a renderer applies, undoes
//! to the exact bytes and selection, and redoes to the result.
use super::super::Engine;
use super::{ok, range};
use crate::{Affinity, DisplayRange, ParagraphKey, SourceEdit};

mod formats;
mod rules;

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    before: String,
    command: String,
    after: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    copied: Option<String>,
    #[serde(default)]
    marks: Option<String>,
}

/// The note without its marks, and the marked source range.
fn unmark(marked: &str, marks: &[char; 3]) -> (String, std::ops::Range<usize>) {
    let mut text = String::new();
    let (mut start, mut end) = (None, None);
    for ch in marked.chars() {
        if ch == marks[0] {
            start = Some(text.len());
            end = Some(text.len());
        } else if ch == marks[1] {
            start = Some(text.len());
        } else if ch == marks[2] {
            end = Some(text.len());
        } else {
            text.push(ch);
        }
    }
    (
        text,
        start.expect("a selection")..end.expect("a selection end"),
    )
}

/// Select source `selection`, on the side of hidden text it names.
fn select_source(engine: &mut Engine, selection: std::ops::Range<usize>) {
    let (start, end) = (
        engine.display_of(selection.start),
        engine.display_of(selection.end),
    );
    let (lo, _) = engine.source_bounds(start);
    let affinity = if lo == selection.start {
        Affinity::Backward
    } else {
        Affinity::Forward
    };
    super::select(engine, start, end, affinity);
}

fn display_selection(engine: &Engine, selection: &std::ops::Range<usize>) -> DisplayRange {
    range(
        engine.display_of(selection.start),
        engine.display_of(selection.end),
    )
}

/// Run one case's command; what it copied, and whether it changed the
/// note. The view change is applied to `view`.
fn run(engine: &mut Engine, case: &Case, view: &mut String) -> String {
    let (revision, selection) = (engine.revision(), engine.selection());
    let mut records = 0;
    let mut count = |_: &SourceEdit| -> Result<(), String> {
        records += 1;
        Ok(())
    };
    let (copied, change) = match case.command.as_str() {
        "copy" => (engine.copy_markdown(revision, selection).unwrap(), None),
        "cut" => engine
            .cut_markdown(revision, selection, &mut count)
            .unwrap(),
        "paste" => {
            let text = case.text.as_deref().expect("pasted text");
            let change = engine
                .paste_markdown(revision, selection, text, &mut count)
                .unwrap();
            (String::new(), change)
        }
        "Enter" | "ShiftEnter" => {
            let key = if case.command == "Enter" {
                ParagraphKey::Enter
            } else {
                ParagraphKey::ShiftEnter
            };
            let change = engine.key(revision, selection, key, &mut count).unwrap();
            (String::new(), change)
        }
        other => panic!("unknown command {other:?}"),
    };
    if let Some(change) = change {
        assert_eq!(records, 1, "{}: one acceptance", case.name);
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    } else {
        assert_eq!(records, 0, "{}: no acceptance", case.name);
    }
    copied
}

#[test]
fn clipboard_cases() {
    let cases: Vec<Case> = [
        include_str!("../../../../tests/fixtures/engine/clipboard/paste.json"),
        include_str!("../../../../tests/fixtures/engine/clipboard/copy-and-cut.json"),
        include_str!("../../../../tests/fixtures/engine/clipboard/plain-enter.json"),
    ]
    .into_iter()
    .flat_map(|file| serde_json::from_str::<Vec<Case>>(file).unwrap())
    .collect();
    assert!(cases.len() >= 100, "{} cases", cases.len());
    let mut failures = Vec::new();
    for case in &cases {
        let marks: Vec<char> = case.marks.as_deref().unwrap_or("|[]").chars().collect();
        let marks = [marks[0], marks[1], marks[2]];
        let (source, selection) = unmark(&case.before, &marks);
        let (want, want_selection) = unmark(&case.after, &marks);
        let mut engine = Engine::open(&source);
        select_source(&mut engine, selection);
        let opening = engine.source_text();
        let opening_selection = engine.selection();
        let groups = engine.history.undo.len();
        let mut view = engine.display_text();
        let copied = run(&mut engine, case, &mut view);
        if let Some(expected) = &case.copied {
            if &copied != expected {
                failures.push(format!(
                    "{}: copied {copied:?}, want {expected:?}",
                    case.name
                ));
                continue;
            }
        }
        let got = engine.source_text();
        let got_selection = engine.selection();
        let fresh = Engine::open(&got);
        if got != want || got_selection != display_selection(&fresh, &want_selection) {
            failures.push(format!(
                "{}: got {got:?} selection {got_selection:?}, want {want:?} selection {:?}",
                case.name,
                display_selection(&fresh, &want_selection)
            ));
            continue;
        }
        assert_eq!(engine.display_text(), fresh.display_text(), "{}", case.name);
        assert_eq!(view, engine.display_text(), "{}: view change", case.name);
        if got == opening {
            if engine.history.undo.len() != groups {
                failures.push(format!("{}: no change left history", case.name));
            }
            continue;
        }
        assert_eq!(engine.history.undo.len(), groups + 1, "{}", case.name);
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        if engine.source_text() != opening || engine.selection() != opening_selection {
            failures.push(format!(
                "{}: undo gave {:?} at {:?}",
                case.name,
                engine.source_text(),
                engine.selection()
            ));
            continue;
        }
        engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
        if engine.source_text() != want || engine.selection() != got_selection {
            failures.push(format!(
                "{}: redo gave {:?}",
                case.name,
                engine.source_text()
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
