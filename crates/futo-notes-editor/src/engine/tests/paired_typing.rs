//! Paired typing: the literal sequences in
//! `tests/fixtures/engine/paired-typing*.json` (the backtick, code blocks,
//! `*` and `~`, `[` and `]`).
//!
//! Each case marks the selection in its source with `|` (a caret) or `[`
//! and `]` (`marks` names other characters when the note needs these) and
//! runs its steps in order: `pair:` text typed under
//! `InputAction::PairedTyping`, `type:` text typed as plain typing,
//! `service:` a text service's replacement (`InputAction::Isolated`), a
//! paragraph key (`PairedBackspace` among them), `Code`, `Bold` or `Italic`
//! (the toolbar's toggles), `Complete:` a note id (the `[[` completion
//! offered at the caret, accepted with that id, from the case's `ids`),
//! `Undo` or `Redo`.
//! After each step the source and the selection must be as marked, with a
//! caret where it maps in the source (`caret_source`), so the two caret
//! stops at a hidden marker differ; `display`, `affinity` and `language`
//! (whether the caret writes a code block's language), when given, must
//! match too. `Select` sends the selection again as a host's echo, `Place`
//! as the user's own. A paired step adds at most one Undo step, and none when it
//! changes nothing.
use super::super::Engine;
use super::{ok, select_source_range, unmark_selection};
use crate::{Affinity, DisplayRange, EditorError, InlineFormat, InputAction, ParagraphKey};
use std::ops::Range;

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    before: String,
    #[serde(default)]
    marks: Option<String>,
    #[serde(default)]
    ids: Vec<String>,
    steps: Vec<Step>,
}

#[derive(serde::Deserialize)]
struct Step {
    #[serde(rename = "do")]
    action: String,
    after: String,
    #[serde(default)]
    display: Option<String>,
    #[serde(default)]
    affinity: Option<Affinity>,
    #[serde(default)]
    language: Option<bool>,
    #[serde(default)]
    error: Option<String>,
}

/// The selection in source offsets, a caret where it maps.
fn source_selection(engine: &Engine) -> Range<usize> {
    let selection: DisplayRange = engine.selection();
    engine.source_selection(selection)
}

fn format(action: &str) -> Option<InlineFormat> {
    match action {
        "Code" => Some(InlineFormat::Code),
        "Bold" => Some(InlineFormat::Bold),
        "Italic" => Some(InlineFormat::Italic),
        _ => None,
    }
}

fn run_step(engine: &mut Engine, action: &str) -> Result<(), EditorError> {
    let revision = engine.revision();
    let selection = engine.selection();
    let key = |name: &str| match name {
        "Enter" => Some(ParagraphKey::Enter),
        "Backspace" => Some(ParagraphKey::Backspace),
        "BackspaceJoiningHeading" => Some(ParagraphKey::BackspaceJoiningHeading),
        "Delete" => Some(ParagraphKey::Delete),
        "PairedBackspace" => Some(ParagraphKey::PairedBackspace),
        _ => None,
    };
    if let Some(text) = action.strip_prefix("pair:") {
        engine.input(
            revision,
            selection,
            text,
            InputAction::PairedTyping,
            &mut ok,
        )?;
    } else if let Some(text) = action.strip_prefix("type:") {
        engine.input(revision, selection, text, InputAction::Typing, &mut ok)?;
    } else if let Some(text) = action.strip_prefix("service:") {
        engine.input(revision, selection, text, InputAction::Isolated, &mut ok)?;
    } else if let Some(key) = key(action) {
        engine.key(revision, selection, key, &mut ok)?;
    } else if let Some(format) = format(action) {
        engine.toggle_format_view(revision, format, &mut ok)?;
    } else if let Some(id) = action.strip_prefix("Complete:") {
        let found = engine
            .wikilink_completion(revision)?
            .ok_or(EditorError::StaleClaim)?;
        engine.accept_wikilink_completion(revision, found.range, &found.query, id, &mut ok)?;
    } else if action == "Select" {
        engine.select_with_affinity(revision, selection, engine.affinity())?;
    } else if action == "Place" {
        engine.place_selection(revision, selection, engine.affinity())?;
    } else if action == "Undo" {
        engine.undo(revision, &mut ok)?;
    } else if action == "Redo" {
        engine.redo(revision, &mut ok)?;
    } else {
        panic!("unknown step {action:?}");
    }
    Ok(())
}

#[test]
fn paired_typing_cases() {
    let mut failures = Vec::new();
    for file in [
        include_str!("../../../tests/fixtures/engine/paired-typing.json"),
        include_str!("../../../tests/fixtures/engine/paired-typing-code-blocks.json"),
        include_str!("../../../tests/fixtures/engine/paired-typing-emphasis.json"),
        include_str!("../../../tests/fixtures/engine/paired-typing-brackets.json"),
    ] {
        let cases: Vec<Case> = serde_json::from_str(file).unwrap();
        run_cases(&cases, &mut failures);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn run_cases(cases: &[Case], failures: &mut Vec<String>) {
    for case in cases {
        let marks: Vec<char> = case.marks.as_deref().unwrap_or("|[]").chars().collect();
        let marks = [marks[0], marks[1], marks[2]];
        let (source, selection) = unmark_selection(&case.before, &marks);
        let mut engine = Engine::open(&source);
        engine.update_note_ids(&case.ids);
        select_source_range(&mut engine, selection);
        for (number, step) in case.steps.iter().enumerate() {
            let context = format!("{} step {} {:?}", case.name, number + 1, step.action);
            let before = engine.source_text();
            let groups = engine.history.undo.len();
            let result = run_step(&mut engine, &step.action);
            let error = result.err().map(|error| format!("{error:?}"));
            if error != step.error {
                failures.push(format!("{context}: got {error:?}, want {:?}", step.error));
                break;
            }
            let (want, want_selection) = unmark_selection(&step.after, &marks);
            let got = engine.source_text();
            let got_selection = source_selection(&engine);
            let display = engine.display_text();
            let affinity = engine.affinity();
            let state = format!(
                "source {got:?} selection {got_selection:?} display {display:?} affinity {affinity:?}"
            );
            if got != want || got_selection != want_selection {
                failures.push(format!(
                    "{context}: got {state}, want {want:?} selection {want_selection:?}"
                ));
                break;
            }
            let language = engine.writes_language();
            if step.display.as_ref().is_some_and(|want| *want != display)
                || step.affinity.is_some_and(|want| want != affinity)
                || step.language.is_some_and(|want| want != language)
            {
                failures.push(format!(
                    "{context}: got {state} language {language}, want display {:?} affinity {:?} language {:?}",
                    step.display, step.affinity, step.language
                ));
                break;
            }
            assert_eq!(display, Engine::open(&got).display_text(), "{context}");
            // A literal backtick may join the typing group before it.
            let undo_steps = engine.history.undo.len().saturating_sub(groups);
            let paired = step.action.starts_with("pair:")
                || step.action.starts_with("Backspace")
                || step.action == "PairedBackspace";
            if paired && (undo_steps > 1 || (got == before && undo_steps != 0)) {
                failures.push(format!("{context}: {undo_steps} new Undo steps"));
            }
        }
    }
}

/// While text is marked, a pair character is typing exactly (rule 10).
#[test]
fn marked_text_makes_paired_typing_plain_typing() {
    for text in ["`", "*", "~", "[", "]"] {
        let mut results = Vec::new();
        for action in [InputAction::PairedTyping, InputAction::Typing] {
            let mut engine = Engine::open("a ");
            let caret = super::range(2, 2);
            engine.compose(engine.revision(), caret, "か").unwrap();
            let selection = engine.selection();
            engine
                .input(engine.revision(), selection, text, action, &mut ok)
                .unwrap();
            results.push((engine.source_text(), engine.selection()));
        }
        assert_eq!(results[0], results[1], "{text:?}");
    }
}

/// Hosts ask the engine's own table which characters pair.
#[test]
fn hosts_read_the_pair_keys_from_the_table() {
    for text in ["`", "*", "~", "[", "]"] {
        assert!(crate::is_paired_typing_key(text), "{text:?}");
    }
    for text in ["(", "_", "**", "a", ""] {
        assert!(!crate::is_paired_typing_key(text), "{text:?}");
    }
}
