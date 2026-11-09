mod support;
use futo_notes_ffi::*;
use support::{path_string, TempTree};

// The mirror, fed each real engine change, tracks the session's display and
// reports UTF-16 edits a native text view can apply directly.
#[test]
fn mirror_follows_a_live_session_through_typing_and_undo() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("n".into(), "".into(), "**日本** tail\n".into())
        .unwrap();
    let session = store.open_editor("n".into()).unwrap();
    let mirror = EditorDisplayMirror::new(session.display_text().unwrap());
    let revision = std::cell::Cell::new(session.revision().unwrap());
    let mut utf16: Vec<u16> = mirror.text().encode_utf16().collect();
    let mut apply = |change: EditorViewChange| {
        let edit = mirror
            .apply_change(
                change.range.start,
                change.range.end,
                change.inserted.clone(),
                change.selection.start,
                change.selection.end,
            )
            .unwrap();
        utf16.splice(
            edit.start as usize..edit.end as usize,
            change.inserted.encode_utf16(),
        );
        revision.set(change.revision);
        assert_eq!(utf16, mirror.text().encode_utf16().collect::<Vec<_>>());
        let selection = session
            .display_to_utf16(revision.get(), change.selection)
            .unwrap();
        assert_eq!(
            (selection.start, selection.end),
            (edit.selection_start, edit.selection_end)
        );
    };
    let caret = EditorUtf16Range { start: 2, end: 2 };
    apply(
        session
            .replace_utf16(revision.get(), caret, "\u{1F600}x".encode_utf16().collect())
            .unwrap(),
    );
    apply(
        session
            .paragraph_key_utf16(
                revision.get(),
                EditorUtf16Range { start: 5, end: 5 },
                EditorParagraphKey::Enter,
            )
            .unwrap()
            .unwrap(),
    );
    apply(session.undo(revision.get()).unwrap().unwrap());
    assert_eq!(mirror.text(), session.display_text().unwrap());
}

#[test]
fn style_plan_reports_utf16_spans_for_a_byte_window() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("n".into(), "".into(), "日本\n\n## Head **b**\n".into())
        .unwrap();
    let session = store.open_editor("n".into()).unwrap();
    let revision = session.revision().unwrap();
    let len = session.display_text().unwrap().len() as u64;
    let spans = session
        .style_plan(revision, EditorByteRange { start: 0, end: len })
        .unwrap();
    assert!(spans.iter().any(|s| matches!(
        s,
        EditorStyleSpan::Heading {
            start: 4,
            level: 2,
            ..
        }
    )));
    assert!(spans.iter().any(|s| matches!(
        s,
        EditorStyleSpan::Inline {
            start: 9,
            end: 10,
            bold: true,
            ..
        }
    )));
}

// The slice and prefix helpers a host uses to show a long note's first screens and render the rest.
#[test]
fn slices_end_on_blank_lines_and_prefixes_match_byte_for_byte() {
    let mirror = EditorDisplayMirror::new("one\ntwo\n\nthree \u{1F600}\nfour\n".into());
    // Target 5 reaches into "two": the slice ends after the line before the blank line (the first newline of it).
    assert_eq!(mirror.slice_end(0, 5).unwrap(), 8);
    // The end of the text is the last slice's end; a slice never splits the emoji pair.
    assert_eq!(mirror.slice_end(0, 10_000).unwrap(), mirror.utf16_len());
    for from in [0, 9, 10] {
        let end = mirror.slice_end(from, 3).unwrap();
        assert!(mirror.utf16_to_byte(end).is_ok(), "{from} -> {end}");
    }
    assert_eq!(mirror.begins_with("one\ntwo".into()), Some(7));
    assert_eq!(mirror.begins_with("One".into()), None);
    assert_eq!(
        mirror.begins_with("one\ntwo\n\nthree \u{1F600}\nfour\nmore".into()),
        None
    );
}
