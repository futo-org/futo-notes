mod support;
use futo_notes_ffi::*;
use support::{path_string, TempTree};

// Input a view takes while a long note's engine session does not exist yet is replayed on the
// session once it lands: keys at the engine's caret, in order; taps and selections mapped through
// what the engine changed. The host side of that is `EditorDisplayMirror` + `EditorPendingEdits`.

/// What the user did against the frozen view: a key's range and the selection the view had.
#[derive(Clone, Copy)]
enum Op {
    Key {
        range: (u64, u64),
        selection: (u64, u64),
        text: &'static str,
    },
    Tap(u64),
}

/// The text the note has once `ops` are replayed on the engine the way a host does it.
fn replay(body: &str, ops: &[Op]) -> String {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("n".into(), "".into(), body.into())
        .unwrap();
    let session = store.open_editor("n".into()).unwrap();
    let mirror = EditorDisplayMirror::new(session.display_text().unwrap());
    let mut rev = session.revision().unwrap();
    let pending = EditorPendingEdits::new();
    let mut engine_selection = (0u64, 0u64);
    for op in ops {
        match *op {
            Op::Tap(at) => {
                let m = pending.map(at, at).unwrap();
                let change = session
                    .select_utf16(
                        rev,
                        EditorUtf16Range {
                            start: m.start,
                            end: m.end,
                        },
                    )
                    .unwrap();
                rev = change.revision;
                engine_selection = (
                    mirror.byte_to_utf16(change.selection.start).unwrap(),
                    mirror.byte_to_utf16(change.selection.end).unwrap(),
                );
            }
            Op::Key {
                range,
                selection,
                text,
            } => {
                let target = host_range(&mirror, range, selection, engine_selection);
                let change = session
                    .replace_utf16(
                        rev,
                        EditorUtf16Range {
                            start: target.0,
                            end: target.1,
                        },
                        text.encode_utf16().collect(),
                    )
                    .unwrap();
                let edit = mirror
                    .apply_change(
                        change.range.start,
                        change.range.end,
                        change.inserted.clone(),
                        change.selection.start,
                        change.selection.end,
                    )
                    .unwrap();
                rev = change.revision;
                pending
                    .record(
                        edit.start,
                        edit.end,
                        edit.inserted_utf16,
                        edit.slack_utf16,
                        target.0,
                    )
                    .unwrap();
                engine_selection = (edit.selection_start, edit.selection_end);
            }
        }
    }
    session
        .display_text()
        .unwrap()
        .trim_end_matches('\n')
        .to_string()
}

fn host_range(
    mirror: &EditorDisplayMirror,
    range: (u64, u64),
    selection: (u64, u64),
    engine_selection: (u64, u64),
) -> (u64, u64) {
    let r = mirror
        .at_caret(
            range.0,
            range.1,
            selection.0,
            selection.1,
            engine_selection.0,
            engine_selection.1,
        )
        .unwrap();
    (r.start, r.end)
}

fn key(range: (u64, u64), selection: (u64, u64), text: &'static str) -> Op {
    Op::Key {
        range,
        selection,
        text,
    }
}

#[test]
fn type_then_backspace_while_opening_is_a_net_no_op() {
    // "hello", caret after it: x, then Backspace (UIKit asks for [4,5) on the view it still shows).
    let ops = [
        Op::Tap(5),
        key((5, 5), (5, 5), "x"),
        key((4, 5), (5, 5), ""),
    ];
    assert_eq!(replay("hello", &ops), "hello");
}

#[test]
fn repeated_backspace_while_opening_deletes_one_character_each() {
    let ops = [Op::Tap(5), key((4, 5), (5, 5), ""), key((4, 5), (5, 5), "")];
    assert_eq!(replay("hello", &ops), "hel");
}

#[test]
fn type_backspace_type_while_opening_keeps_the_last_key() {
    let ops = [
        Op::Tap(5),
        key((5, 5), (5, 5), "x"),
        key((4, 5), (5, 5), ""),
        key((5, 5), (5, 5), "y"),
    ];
    assert_eq!(replay("hello", &ops), "helloy");
}

#[test]
fn a_tap_after_typing_inside_a_run_of_identical_characters_lands_where_the_finger_did() {
    // "aa": type a at the start, tap between the original two a's, type b: "aa" + "b" + "a".
    let ops = [
        key((0, 0), (0, 0), "a"),
        Op::Tap(1),
        key((1, 1), (1, 1), "b"),
    ];
    assert_eq!(replay("aa", &ops), "aaba");
}
