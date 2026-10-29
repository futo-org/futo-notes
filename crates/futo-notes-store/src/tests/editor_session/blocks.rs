use super::*;
use futo_notes_editor::{BlockCommand, DisplayUtf16Offset, DisplayUtf16Range, ParagraphKey};
fn range(a: usize, b: usize) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(a),
        end: DisplayUtf16Offset(b),
    }
}
#[test]
fn shortcut_and_carried_heading_input_recover_and_checkpoint_exactly() {
    for (opening, entered, final_source, display, caret) in [
        (
            "\\#A #\r\ntail  ",
            "# A \\#\r\ntail  ",
            "# A \\#\r\ntail  ",
            "A #\r\ntail  ",
            1,
        ),
        (
            "# __ab__\r\ntail  ",
            "# __ab__\n\r\ntail  ",
            "# __ab__\n__c__\r\ntail  ",
            "ab\nc\r\ntail  ",
            2,
        ),
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "blocks", opening).unwrap();
        {
            let mut editor = store.open_editor("blocks").unwrap();
            if caret == 1 {
                editor
                    .select_utf16(Revision(0), range(caret, caret))
                    .unwrap();
                editor
                    .replace_utf16(Revision(0), range(1, 1), &[32])
                    .unwrap();
            } else {
                editor
                    .paragraph_key_utf16(Revision(0), range(2, 2), ParagraphKey::Enter)
                    .unwrap()
                    .unwrap();
            }
            assert_eq!(editor.source_text(), entered);
            editor.undo(editor.revision()).unwrap().unwrap();
            assert_eq!(editor.source_text(), opening);
            editor.redo(editor.revision()).unwrap().unwrap();
            assert_eq!(editor.source_text(), entered);
            if caret == 2 {
                editor
                    .replace(editor.revision(), editor.selection(), "c")
                    .unwrap();
            }
            assert_eq!(editor.source_text(), final_source);
            assert_eq!(editor.display_text(), display);
            assert_eq!(store.read("blocks").unwrap(), opening);
            editor.flush_recovery().unwrap();
        }
        let mut recovered = store.open_editor("blocks").unwrap();
        assert_eq!(recovered.source_text(), final_source);
        assert_eq!(recovered.display_text(), display);
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("blocks").unwrap(), final_source);
        drop(recovered);
        assert_eq!(
            store.open_editor("blocks").unwrap().source_text(),
            final_source
        );
    }
}
#[test]
fn block_commands_structural_enter_checkpoint_and_recovery_keep_literal_bytes() {
    for (opening, command, expected, shown) in [
        (
            "   foo",
            BlockCommand::Heading(2),
            "## &#32;  foo",
            "   foo",
        ),
        ("   # foo", BlockCommand::Heading(0), "foo", "foo"),
        ("> ## Title ##", BlockCommand::Quote, "> Title", "Title"),
        (
            "> foo\n> bar\n> ===",
            BlockCommand::Heading(0),
            "> foo\n> bar",
            "foo\nbar",
        ),
        (
            "before\r\nA\r\nend  \r\n",
            BlockCommand::Heading(6),
            "###### before\r\nA\r\nend  \r\n",
            "before\r\nA\r\nend  \r\n",
        ),
        ("", BlockCommand::Divider, "---\n", "\u{fffc}\n"),
        (
            "> > deep\r\n\r\nend  ",
            BlockCommand::Indent,
            "> > > deep\r\n\r\nend  ",
            "deep\r\n\r\nend  ",
        ),
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "blocks", opening).unwrap();
        {
            let mut editor = store.open_editor("blocks").unwrap();
            editor
                .block_command_utf16(Revision(0), range(0, 0), command)
                .unwrap()
                .unwrap();
            assert_eq!(editor.source_text(), expected);
            assert_eq!(editor.display_text(), shown);
            editor.undo(editor.revision()).unwrap().unwrap();
            assert_eq!(editor.source_text(), opening);
            editor.redo(editor.revision()).unwrap().unwrap();
            assert_eq!(editor.source_text(), expected);
            assert_eq!(store.read("blocks").unwrap(), opening);
            editor.flush_recovery().unwrap();
        }
        let mut recovered = store.open_editor("blocks").unwrap();
        assert_eq!(recovered.source_text(), expected);
        assert_eq!(recovered.display_text(), shown);
        assert!(recovered.undo(recovered.revision()).unwrap().is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("blocks").unwrap(), expected);
        drop(recovered);
        assert_eq!(store.open_editor("blocks").unwrap().source_text(), expected);
    }
    let root = TestRoot::new();
    let store = store(&root);
    store
        .create("", "quote", "> __ab__\r\n\r\ntail  \r\n")
        .unwrap();
    {
        let mut editor = store.open_editor("quote").unwrap();
        editor
            .paragraph_key_utf16(Revision(0), range(1, 1), ParagraphKey::Enter)
            .unwrap()
            .unwrap();
    }
    let mut recovered = store.open_editor("quote").unwrap();
    assert_eq!(
        recovered.source_text(),
        "> __a__\n>\n> __b__\r\n\r\ntail  \r\n"
    );
    recovered.checkpoint().unwrap();
    assert_eq!(
        store.read("quote").unwrap(),
        "> __a__\n>\n> __b__\r\n\r\ntail  \r\n"
    );
}
