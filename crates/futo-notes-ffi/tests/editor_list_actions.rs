//! The list family's literal cases (`futo-notes-editor/tests/fixtures/engine/lists/*.json`,
//! run on the core by `engine::tests::lists::list_cases`) through the native
//! surface: a planted note, the selection given in native UTF-16 coordinates,
//! the key, typed text or toolbar command, then the view change, Undo and Redo,
//! and the exact bytes a save writes and a reopen reads.
mod support;
use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession};
use futo_notes_ffi::{
    EditorAffinity, EditorBlockCommand, EditorByteRange, EditorDisplayByteOffset,
    EditorInputAction, EditorParagraphKey, EditorViewChange, NativeEditorSession as NativeSession,
    NoteStore,
};
use serde_json::Value;
use std::ops::Range;
use support::{path_string, TempTree};


/// The text without its marks (`‸` a caret, `«` `»` a selection), and the
/// marked source range.
fn unmark(marked: &str) -> (String, Range<usize>) {
    let mut text = String::new();
    let (mut start, mut end) = (None, None);
    for ch in marked.chars() {
        match ch {
            '‸' => {
                start = Some(text.len());
                end = Some(text.len());
            }
            '«' => start = Some(text.len()),
            '»' => end = Some(text.len()),
            ch => text.push(ch),
        }
    }
    (text, start.unwrap()..end.unwrap())
}

fn apply(view: &mut String, change: &EditorViewChange) {
    view.replace_range(
        change.range.start as usize..change.range.end as usize,
        &change.inserted,
    );
}

/// The source offsets display offset `at` stands between (before and after
/// hidden syntax there).
fn bounds(s: &NativeSession, at: usize) -> (usize, usize) {
    let revision = s.revision().unwrap();
    let side = |affinity| {
        let offset = EditorDisplayByteOffset { offset: at as u64 };
        s.source_at(revision, offset, affinity).unwrap().offset as usize
    };
    (side(EditorAffinity::Backward), side(EditorAffinity::Forward))
}

/// The display offset whose bounds hold source offset `at`.
fn display_of(s: &NativeSession, at: usize) -> usize {
    let display = s.display_text().unwrap();
    let mut offsets = display.char_indices().map(|(at, _)| at);
    offsets
        .by_ref()
        .chain([display.len()])
        .find(|&d| {
            let (lo, hi) = bounds(s, d);
            lo <= at && at <= hi
        })
        .unwrap()
}

/// Selects source `selected` as the core's case run does: a caret before
/// hidden syntax takes Backward affinity. Returns the display range.
fn select_source(s: &NativeSession, selected: &Range<usize>) -> EditorByteRange {
    let (start, end) = (display_of(s, selected.start), display_of(s, selected.end));
    let affinity = if selected.is_empty() && bounds(s, start).0 == selected.start {
        EditorAffinity::Backward
    } else {
        EditorAffinity::Forward
    };
    let range = EditorByteRange {
        start: start as u64,
        end: end as u64,
    };
    s.select_with_affinity(s.revision().unwrap(), range.clone(), affinity)
        .unwrap();
    range
}

/// A change's selection in source offsets, as the core reads it: a caret by
/// its affinity, a range from after the hidden syntax at its start to before
/// the hidden syntax at its end.
fn selected_source(s: &NativeSession, change: &EditorViewChange) -> Range<usize> {
    let (start, end) = (
        change.selection.start as usize,
        change.selection.end as usize,
    );
    if start == end {
        let (lo, hi) = bounds(s, start);
        let at = if change.affinity == EditorAffinity::Backward {
            lo
        } else {
            hi
        };
        return at..at;
    }
    let start = bounds(s, start).1;
    start..bounds(s, end).0.max(start)
}

/// Each block of the whole projection, comparable across the two surfaces.
type Block = (u64, u64, u8, u64, Option<(u64, String, bool, Option<bool>)>);

fn native_blocks(s: &NativeSession) -> Vec<Block> {
    let end = s.display_text().unwrap().len() as u64;
    let all = EditorByteRange { start: 0, end };
    let slice = s.project(s.revision().unwrap(), all).unwrap();
    slice
        .blocks
        .into_iter()
        .map(|block| {
            let list = block
                .list
                .map(|list| (list.indent, list.marker, list.ordered, list.checked));
            let range = (block.range.start, block.range.end);
            (range.0, range.1, block.heading, block.quote_depth, list)
        })
        .collect()
}

fn direct_blocks(source: &str) -> Vec<Block> {
    let s = EditorSession::open(source);
    let end = DisplayOffset(s.display_text().len());
    let all = DisplayRange {
        start: DisplayOffset(0),
        end,
    };
    let slice = s.project(s.revision(), all).unwrap();
    slice
        .blocks
        .into_iter()
        .map(|block| {
            let list = block.list.map(|list| {
                let indent = list.indent as u64;
                (indent, list.marker, list.ordered, list.checked)
            });
            let range = (block.range.start.0 as u64, block.range.end.0 as u64);
            (range.0, range.1, block.heading, block.quote_depth as u64, list)
        })
        .collect()
}

fn run(s: &NativeSession, command: &str, at: EditorByteRange) -> Option<EditorViewChange> {
    let native = s.display_to_utf16(0, at).unwrap();
    if let Some(text) = command.strip_prefix("type:") {
        let typed = text.encode_utf16().collect();
        let change = s
            .replace_utf16_action(0, native, typed, EditorInputAction::Typing)
            .unwrap();
        return (change.revision != 0).then_some(change);
    }
    let key = match command {
        "Enter" => Some(EditorParagraphKey::Enter),
        "ShiftEnter" => Some(EditorParagraphKey::ShiftEnter),
        "Backspace" => Some(EditorParagraphKey::Backspace),
        "BackspaceJoiningHeading" => Some(EditorParagraphKey::BackspaceJoiningHeading),
        "Delete" => Some(EditorParagraphKey::Delete),
        "Tab" => Some(EditorParagraphKey::Tab),
        "ShiftTab" => Some(EditorParagraphKey::ShiftTab),
        _ => None,
    };
    if let Some(key) = key {
        return s.paragraph_key_utf16(0, native, key).unwrap();
    }
    let command = match command {
        "Indent" => EditorBlockCommand::Indent,
        "Outdent" => EditorBlockCommand::Outdent,
        "BulletList" => EditorBlockCommand::BulletList,
        "OrderedList" => EditorBlockCommand::OrderedList,
        "TaskList" => EditorBlockCommand::TaskList,
        "ToggleTask" => EditorBlockCommand::ToggleTask,
        other => panic!("unknown command {other:?}"),
    };
    s.block_command_utf16(0, native, command).unwrap()
}

/// Source after an authored save of `source`: a nonempty note without a
/// final line ending gains its own (CRLF or LF; portable-core/recovery.md).
fn saved(source: &str) -> String {
    if source.is_empty() || source.ends_with('\n') {
        return source.to_owned();
    }
    let ending = if source.contains("\r\n") { "\r\n" } else { "\n" };
    format!("{source}{ending}")
}

#[test]
fn shared_list_actions_forward_native_coordinates_history_and_exact_saves() {
    let cases: Vec<Value> = [
        include_str!("../../futo-notes-editor/tests/fixtures/engine/lists/enter.json"),
        include_str!("../../futo-notes-editor/tests/fixtures/engine/lists/backspace-delete.json"),
        include_str!("../../futo-notes-editor/tests/fixtures/engine/lists/indent.json"),
        include_str!("../../futo-notes-editor/tests/fixtures/engine/lists/toggles.json"),
        include_str!("../../futo-notes-editor/tests/fixtures/engine/lists/typed.json"),
    ]
    .into_iter()
    .flat_map(|file| serde_json::from_str::<Vec<Value>>(file).unwrap())
    .collect();
    assert!(cases.len() >= 150, "{} cases", cases.len());
    // A typed final line ending a planted note lacked is not saved (the store
    // counts the draft as on disk already); collected, so every case runs.
    let mut unsaved = Vec::new();
    for case in &cases {
        let text = |key: &str| case[key].as_str().unwrap();
        let name = text("name");
        let (before, selected) = unmark(text("before"));
        let (after, landed) = unmark(text("after"));
        let tree = TempTree::new();
        std::fs::create_dir_all(tree.path("vault")).unwrap();
        let store = NoteStore::new(path_string(&tree.path("vault")));
        // Exactly these bytes, which may lack a final line ending.
        std::fs::write(tree.path("vault/lists.md"), &before).unwrap();
        let s = store.open_editor("lists".into()).unwrap();
        let mut view = s.display_text().unwrap();
        assert_eq!(view, EditorSession::open(&before).display_text(), "{name}");
        let opening = select_source(&s, &selected);
        let Some(change) = run(&s, text("command"), opening.clone()) else {
            assert_eq!(before, after, "{name}: no change");
            assert_eq!(s.source_text().unwrap(), before, "{name}");
            assert!(s.undo(0).unwrap().is_none(), "{name}: no history");
            continue;
        };
        assert_ne!(before, after, "{name}: a change");
        assert_eq!(change.revision, 1, "{name}");
        apply(&mut view, &change);
        assert_eq!(s.source_text().unwrap(), after, "{name}");
        assert_eq!(view, EditorSession::open(&after).display_text(), "{name}");
        assert_eq!(selected_source(&s, &change), landed, "{name}: selection");
        assert_eq!(native_blocks(&s), direct_blocks(&after), "{name}: blocks");

        let undone = s.undo(1).unwrap().unwrap();
        apply(&mut view, &undone);
        assert_eq!(s.source_text().unwrap(), before, "{name}: undo");
        assert_eq!(view, EditorSession::open(&before).display_text(), "{name}");
        assert_eq!(
            s.display_to_utf16(undone.revision, undone.selection).unwrap(),
            s.display_to_utf16(undone.revision, opening).unwrap(),
            "{name}: undo's selection"
        );
        assert!(s.undo(undone.revision).unwrap().is_none(), "{name}");
        apply(&mut view, &s.redo(undone.revision).unwrap().unwrap());
        assert_eq!(s.source_text().unwrap(), after, "{name}: redo");
        assert_eq!(view, s.display_text().unwrap(), "{name}");

        s.checkpoint().unwrap();
        s.detach().unwrap();
        let saved = saved(&after);
        let read = store.read("lists".into()).unwrap();
        if read != saved {
            unsaved.push(format!("{name}: {after:?} saved as {read:?}"));
            continue;
        }
        let recovered = store.open_editor("lists".into()).unwrap();
        assert_eq!(recovered.source_text().unwrap(), saved, "{name}");
        assert_eq!(
            recovered.display_text().unwrap(),
            EditorSession::open(&saved).display_text(),
            "{name}"
        );
        let revision = recovered.revision().unwrap();
        assert!(recovered.undo(revision).unwrap().is_none(), "{name}");
        recovered.detach().unwrap();
    }
    assert!(unsaved.is_empty(), "{}", unsaved.join("\n"));
}
