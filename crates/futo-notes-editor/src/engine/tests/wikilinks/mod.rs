//! Wikilinks and tags on the core: completion, note ids, relinks, tag
//! queries and header tags. Before/after cases are in
//! `tests/fixtures/engine/wikilinks.json`; `‸` marks a caret and `«` `»` a
//! selection, in the source.
use super::super::Engine;
use super::{ok, range};

mod completion;
mod note_ids;
mod relink;
mod roles;
mod tags;
use crate::{
    Affinity, DisplayRange, EditorError, InputAction, Revision, SourceEdit, ViewChange,
    WikilinkCompletion,
};
use std::ops::Range;

const VAULT: &[&str] = &[
    "Projects/Roadmap",
    "Other/Notes",
    "Work/Notes",
    "Ünï/İstanbul",
];

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|id| id.to_string()).collect()
}

/// `text` without its selection marks, and the selection in source offsets.
fn unmark(text: &str) -> (String, Range<usize>) {
    if let Some(at) = text.find('‸') {
        return (text.replacen('‸', "", 1), at..at);
    }
    match (text.find('«'), text.find('»')) {
        (Some(start), Some(end)) => (
            text.replacen('«', "", 1).replacen('»', "", 1),
            start..end - '«'.len_utf8(),
        ),
        _ => (text.to_owned(), usize::MAX..usize::MAX),
    }
}

/// `engine` opened on `before` with the vault's ids and the marked selection.
fn opened(before: &str, note_ids: &[String]) -> Engine {
    let (source, selection) = unmark(before);
    let mut engine = Engine::open(&source);
    engine.update_note_ids(note_ids);
    if selection.start != usize::MAX {
        engine.land(selection, None);
    }
    engine
}

/// The source selection, marked into the source, when `marked` asks for one.
fn marked(engine: &Engine, like: &str) -> String {
    let source = engine.source_text();
    if like.contains('‸') {
        let at = engine.source_selection(engine.selection()).start;
        return format!("{}‸{}", &source[..at], &source[at..]);
    }
    if like.contains('«') {
        let range = engine.source_selection(engine.selection());
        return format!(
            "{}«{}»{}",
            &source[..range.start],
            &source[range.clone()],
            &source[range.end..]
        );
    }
    source
}

/// The display after applying `change` to `display`.
fn applied(display: &str, change: &ViewChange) -> String {
    let mut text = display.to_owned();
    text.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    text
}

/// The engine reads, shows and projects exactly as a fresh read of its text.
fn as_fresh(engine: &Engine, note_ids: &[String], context: &str) {
    let mut fresh = Engine::open(&engine.source_text());
    fresh.update_note_ids(note_ids);
    assert_eq!(engine.display_text(), fresh.display_text(), "{context}");
    let all = range(0, engine.display_len());
    assert_eq!(
        engine.projection(engine.revision(), all),
        fresh.projection(engine.revision(), all),
        "{context}"
    );
}

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    before: String,
    command: String,
    arg: String,
    after: String,
    ids: Option<Vec<String>>,
}

fn command(engine: &mut Engine, case: &Case) -> Option<ViewChange> {
    let revision = engine.revision();
    let arg = case.arg.as_str();
    match case.command.as_str() {
        "accept_completion" => {
            let found = engine
                .wikilink_completion(revision)
                .unwrap()
                .unwrap_or_else(|| panic!("{}: no run", case.name));
            let change = engine
                .accept_wikilink_completion(revision, found.range, &found.query, arg, &mut ok)
                .unwrap_or_else(|error| panic!("{}: {error:?}", case.name));
            Some(change)
        }
        "add_header_tag" => engine.add_header_tag(revision, arg, &mut ok).unwrap(),
        "remove_header_tag" => engine.remove_header_tag(revision, arg, &mut ok).unwrap(),
        "relink" => engine.apply_own_relink(revision, arg, &mut ok).unwrap(),
        other => panic!("unknown command {other}"),
    }
}

#[test]
fn wikilink_and_tag_commands_write_these_bytes() {
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/engine/wikilinks.json"
    ))
    .unwrap();
    assert!(cases.len() >= 40);
    for case in &cases {
        let name = &case.name;
        let note_ids = case.ids.clone().unwrap_or_else(|| ids(VAULT));
        let mut engine = opened(&case.before, &note_ids);
        let before = marked(&engine, &case.before);
        let display = engine.display_text();
        let selection = engine.selection();
        let change = command(&mut engine, case);
        assert_eq!(marked(&engine, &case.after), case.after, "{name}");
        as_fresh(&engine, &note_ids, name);
        let Some(change) = change else {
            assert_eq!(case.before, case.after, "{name}: changed nothing");
            assert!(!engine.can_undo(), "{name}: no history");
            continue;
        };
        assert_eq!(applied(&display, &change), engine.display_text(), "{name}");
        assert_eq!(change.selection, engine.selection(), "{name}");
        let after = engine.selection();
        // One Undo restores the bytes and the selection; Redo the command.
        let undone = engine
            .undo(engine.revision(), &mut ok)
            .unwrap()
            .expect("undo");
        assert_eq!(marked(&engine, &case.before), before, "{name}: undo");
        assert_eq!(engine.selection(), selection, "{name}: undo selection");
        assert!(!engine.can_undo(), "{name}: one undo step");
        let _ = undone;
        engine
            .redo(engine.revision(), &mut ok)
            .unwrap()
            .expect("redo");
        assert_eq!(engine.source_text(), unmark(&case.after).0, "{name}: redo");
        assert_eq!(engine.selection(), after, "{name}: redo selection");
    }
}

// ---- Wikilink roles, shared by the files below ----

/// (visible glyphs, target, label, note id) of every wikilink.
type Role = (String, String, String, Option<String>);

fn roles(engine: &Engine) -> Vec<Role> {
    let display = engine.display_text();
    engine
        .projection(engine.revision(), range(0, display.len()))
        .wikilinks
        .into_iter()
        .map(|link| {
            (
                display[link.range.start.0..link.range.end.0].to_owned(),
                link.target,
                link.label,
                link.note_id,
            )
        })
        .collect()
}

fn role(glyphs: &str, target: &str, label: &str, id: Option<&str>) -> Role {
    (
        glyphs.into(),
        target.into(),
        label.into(),
        id.map(Into::into),
    )
}

fn with_ids(source: &str, list: &[&str]) -> Engine {
    let mut engine = Engine::open(source);
    engine.update_note_ids(&ids(list));
    engine
}

const LINKED: &[&str] = &["Projects/Roadmap", "Other/Notes", "Work/Notes", "a|b"];
