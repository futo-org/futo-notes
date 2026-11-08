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
    Select(u64, u64),
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
            Op::Tap(_) | Op::Select(..) => {
                let (from, to) = match *op {
                    Op::Tap(at) => (at, at),
                    Op::Select(from, to) => (from, to),
                    Op::Key { .. } => unreachable!(),
                };
                let m = pending.map(from, to).unwrap();
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
                let target = host_range(
                    &mirror,
                    deleted(body, range, text),
                    range,
                    selection,
                    engine_selection,
                );
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

/// The frozen text a deletion removes (what the host reads from its view), `None` for a key that
/// types.
fn deleted(body: &str, range: (u64, u64), text: &str) -> Option<String> {
    let units: Vec<u16> = body.encode_utf16().collect();
    let removed = String::from_utf16_lossy(&units[range.0 as usize..range.1 as usize]);
    text.is_empty().then_some(removed)
}

fn host_range(
    mirror: &EditorDisplayMirror,
    deleted: Option<String>,
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
            deleted,
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

fn tap(at: u64) -> Op {
    Op::Tap(at)
}

fn expect(body: &str, ops: &[Op], want: &str) {
    assert_eq!(replay(body, ops), want);
}

// A Backspace is the engine's character before the engine's caret, not the width of the character
// before the frozen view's caret: the keys before it have moved the one and not the other.

#[test]
fn backspace_after_typing_beside_an_emoji_deletes_one_typed_character() {
    // "😀" with the caret after it: b, a, Backspace (the view asks for the emoji's two units).
    let ops = [
        Op::Tap(2),
        key((2, 2), (2, 2), "b"),
        key((2, 2), (2, 2), "a"),
        key((0, 2), (2, 2), ""),
    ];
    expect("\u{1F600}", &ops, "\u{1F600}b");
}

#[test]
fn repeated_backspace_over_an_emoji_after_a_letter_deletes_one_character_each() {
    let ops = [Op::Tap(4), key((2, 4), (4, 4), ""), key((2, 4), (4, 4), "")];
    expect("ab\u{1F600}", &ops, "a");
}

#[test]
fn backspace_after_a_typed_emoji_deletes_it() {
    let ops = [
        Op::Tap(1),
        key((1, 1), (1, 1), "\u{1F600}"),
        key((0, 1), (1, 1), ""),
    ];
    expect("x", &ops, "x");
}

#[test]
fn backspace_over_a_crlf_after_typing_leaves_no_lone_cr() {
    // "ab\r\ncd", caret at the start of line 2: x, Backspace (the view asks for the CRLF).
    let ops = [
        Op::Tap(4),
        key((4, 4), (4, 4), "x"),
        key((2, 4), (4, 4), ""),
    ];
    expect("ab\r\ncd\r\n", &ops, "ab\r\ncd\r");
}

#[test]
fn backspace_after_typing_over_a_selection_deletes_the_typed_text() {
    let ops = [
        Op::Select(6, 11),
        key((6, 11), (6, 11), "X"),
        key((6, 11), (6, 11), ""),
    ];
    expect("hello world", &ops, "hello ");
}

#[test]
fn a_tap_at_the_start_of_a_replaced_range_stays_a_caret() {
    let ops = [
        Op::Select(6, 11),
        key((6, 11), (6, 11), "X"),
        Op::Tap(6),
        key((6, 6), (6, 6), "Y"),
    ];
    expect("hello world", &ops, "hello YX");
}

/// Random keys against a frozen view, checked against a live document that takes the same keys:
/// type a character, or Backspace the character before the caret. Every Backspace is asked the
/// way UIKit asks it: the view's own character before the view's frozen caret, in units.
#[test]
fn keys_replayed_after_opening_equal_the_keys_on_a_live_document() {
    let alphabet = [
        "a",
        "a",
        "b",
        "\u{1F600}",
        "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
        "\r\n",
    ];
    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    let mut next = |n: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % n as u64) as usize
    };
    let units = |elements: &[&str]| {
        elements
            .iter()
            .map(|e| e.encode_utf16().count() as u64)
            .sum::<u64>()
    };
    let mut failures = Vec::new();
    for _ in 0..600 {
        let mut view: Vec<&str> = (0..1 + next(6))
            .map(|_| alphabet[next(alphabet.len())])
            .collect();
        view.push("z");
        let body: String = view.concat();
        let gap = next(view.len() + 1);
        let at = units(&view[..gap]);
        let mut live = view.clone();
        let mut caret = gap;
        let mut ops = vec![Op::Tap(at)];
        let mut typed = Vec::new();
        for _ in 0..1 + next(6) {
            if gap > 0 && next(2) == 0 {
                let before = units(&view[..gap - 1]);
                ops.push(Op::Key {
                    range: (before, at),
                    selection: (at, at),
                    text: "",
                });
                if caret > 0 {
                    caret -= 1;
                    live.remove(caret);
                }
                typed.push("BS".to_string());
            } else {
                let element = ["a", "b", "\u{1F600}"][next(3)];
                ops.push(Op::Key {
                    range: (at, at),
                    selection: (at, at),
                    text: element,
                });
                live.insert(caret, element);
                caret += 1;
                typed.push(element.to_string());
            }
        }
        let want = live.concat();
        let got = replay(&body, &ops);
        // The engine ends a note with a line ending the model does not have.
        if got.trim_end_matches(['\r', '\n']) != want.trim_end_matches(['\r', '\n']) {
            failures.push(format!(
                "{view:?} caret {gap} keys {typed:?}: got {got:?} want {want:?}"
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of 600 failed, first: {:?}",
        failures.len(),
        failures.first()
    );
}

#[test]
fn a_selection_ending_where_a_queued_replacement_starts_leaves_the_replacement_alone() {
    // Select "world", type X; select "hello " (it ends where X begins), type Z: "ZX".
    let ops = [
        Op::Select(6, 11),
        key((6, 11), (6, 11), "X"),
        Op::Select(0, 6),
        key((0, 6), (0, 6), "Z"),
    ];
    expect("hello world", &ops, "ZX");
}

#[test]
fn a_word_delete_while_opening_deletes_the_word_before_the_engines_caret() {
    // "hello world", caret at the end: s, then Option-Backspace (the view asks for "world").
    let ops = [
        Op::Tap(11),
        key((11, 11), (11, 11), "s"),
        key((6, 11), (11, 11), ""),
    ];
    expect("hello world", &ops, "hello ");
}
