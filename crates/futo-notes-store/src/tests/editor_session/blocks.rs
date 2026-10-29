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

#[test]
fn setext_physical_ownership_survives_append_replay_and_checkpoint() {
    for (opening, shown, action, selected, expected, display) in [
        ("#x\n=", "#x", "text", range(0, 2), "#x", "#x"),
        (
            "> x\n> y\n> =",
            "x\ny",
            "indent",
            range(0, 3),
            "> > x\n> > y\n> > =",
            "x\ny",
        ),
        (
            "> > x\r\n> > y\r\n> > ---",
            "x\r\ny",
            "outdent",
            range(0, 4),
            "> x\r\n> y\r\n> ---",
            "x\r\ny",
        ),
        (
            "> > 猫🦊\r\n> > e\u{301}\r\n> > ===",
            "猫🦊\r\ne\u{301}",
            "enter",
            range(5, 5),
            "> > 猫🦊\r\n> > ===\r\n\n> > e\u{301}",
            "猫🦊\r\n\ne\u{301}",
        ),
        ("> x\n> =", "x", "enter", range(0, 1), "> # \n> ", "\n"),
        ("> x\n> =", "x", "delete", range(0, 1), "> # ", ""),
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "setext", opening).unwrap();
        {
            let mut editor = store.open_editor("setext").unwrap();
            assert_eq!(editor.display_text(), shown);
            editor.select_utf16(Revision(0), selected).unwrap();
            match action {
                "enter" => {
                    editor
                        .paragraph_key_utf16(Revision(0), selected, ParagraphKey::Enter)
                        .unwrap()
                        .unwrap();
                }
                "delete" => {
                    editor.replace_utf16(Revision(0), selected, &[]).unwrap();
                }
                _ => {
                    let command = match action {
                        "text" => BlockCommand::Heading(0),
                        "indent" => BlockCommand::Indent,
                        "outdent" => BlockCommand::Outdent,
                        _ => unreachable!(),
                    };
                    editor
                        .block_command_utf16(Revision(0), selected, command)
                        .unwrap()
                        .unwrap();
                }
            }
            assert_eq!(editor.source_text(), expected);
            assert_eq!(editor.display_text(), display);
            editor.undo(editor.revision()).unwrap().unwrap();
            assert_eq!(editor.source_text(), opening);
            editor.redo(editor.revision()).unwrap().unwrap();
            assert_eq!(editor.source_text(), expected);
            assert_eq!(store.read("setext").unwrap(), opening);
            editor.flush_recovery().unwrap();
        }
        let mut recovered = store.open_editor("setext").unwrap();
        assert_eq!(recovered.source_text(), expected);
        assert_eq!(recovered.display_text(), display);
        assert!(recovered.undo(recovered.revision()).unwrap().is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("setext").unwrap(), expected);
        drop(recovered);
        assert_eq!(store.open_editor("setext").unwrap().source_text(), expected);
    }
}

#[test]
fn complete_block_body_edits_and_returned_caret_input_recover_exactly() {
    for (opening, action, selected, expected, display, followup) in [
        (
            "> ## # ab ##\n> ## cd ###",
            "delete",
            range(0, 7),
            "> ##  ! ###",
            "!",
            true,
        ),
        ("> ab\n> ===", "space", range(0, 2), "> # &#32;", " ", false),
        (
            "> a\n> b\n> =",
            "divider",
            range(0, 0),
            "> ---\n> \n> a\n> b\n> =",
            "\u{fffc}\n\na\nb",
            false,
        ),
        (
            "> a\n> b\n> =",
            "divider",
            range(0, 3),
            "> ---\n> ",
            "\u{fffc}\n",
            false,
        ),
        (
            "> 猫🦊\n> e\u{301}z\n> ===",
            "divider",
            range(7, 7),
            "> 猫🦊\n> e\u{301}z\n> ===\n> ***\n> ",
            "猫🦊\ne\u{301}z\n\u{fffc}\n",
            false,
        ),
        ("a\nb\n===", "heading", range(0, 3), "### a b", "a b", false),
        (
            "> ab ##\n> cd ###\n> ===",
            "heading",
            range(0, 12),
            "> ### ab ## cd \\###",
            "ab ## cd ###",
            false,
        ),
        ("## x y", "delete", range(0, 0), "## &#32;y", " y", false),
        ("## # ab", "delete", range(0, 0), "## &#32;ab", " ab", false),
        ("#x\n=", "backspace", range(2, 2), "\\#\n=", "#", false),
        ("## x", "space", range(0, 1), "## &#32;", " ", false),
        ("x\n=", "newline", range(0, 1), "# \n", "\n", false),
        (
            "> __ab\n> cd__",
            "enter",
            range(1, 1),
            "> __a__\n>\n> __!b__\n> __cd__",
            "a\n\n!b\ncd",
            true,
        ),
        (
            "> __ab\n> cd__\n> ===",
            "enter",
            range(1, 1),
            "> __a__\n> ===\n> __!b__\n> __cd__",
            "a\n!b\ncd",
            true,
        ),
        (
            "> `ab`\n> `cd`\n> ---",
            "delete",
            range(3, 3),
            "> `ab`\n> `!d`\n> ---",
            "ab\n!d",
            true,
        ),
        (
            "> ab\ncd\n> ===",
            "divider",
            range(1, 4),
            "> a\n> ===\n> ***\n> \n> d\n> ===",
            "a\n\u{fffc}\n\nd",
            false,
        ),
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "body", opening).unwrap();
        {
            let mut editor = store.open_editor("body").unwrap();
            editor.select_utf16(Revision(0), selected).unwrap();
            match action {
                "heading" | "divider" => {
                    editor
                        .block_command_utf16(
                            Revision(0),
                            selected,
                            if action == "heading" {
                                BlockCommand::Heading(3)
                            } else {
                                BlockCommand::Divider
                            },
                        )
                        .unwrap()
                        .unwrap();
                }
                "space" | "newline" => {
                    editor
                        .replace_utf16_action(
                            Revision(0),
                            selected,
                            if action == "space" { &[32] } else { &[10] },
                            futo_notes_editor::InputAction::Isolated,
                        )
                        .unwrap();
                }
                _ => {
                    editor
                        .paragraph_key_utf16(
                            Revision(0),
                            selected,
                            match action {
                                "enter" => ParagraphKey::Enter,
                                "delete" => ParagraphKey::Delete,
                                "backspace" => ParagraphKey::Backspace,
                                _ => unreachable!(),
                            },
                        )
                        .unwrap()
                        .unwrap();
                }
            }
            if followup {
                editor
                    .replace_action(
                        editor.revision(),
                        editor.selection(),
                        "!",
                        futo_notes_editor::InputAction::Isolated,
                    )
                    .unwrap();
            }
            assert_eq!(editor.source_text(), expected, "{opening:?}/{action}");
            assert_eq!(editor.display_text(), display);
            editor.undo(editor.revision()).unwrap().unwrap();
            if followup {
                editor.undo(editor.revision()).unwrap().unwrap();
            }
            assert_eq!(editor.source_text(), opening);
            editor.redo(editor.revision()).unwrap().unwrap();
            if followup {
                editor.redo(editor.revision()).unwrap().unwrap();
            }
            assert_eq!(editor.source_text(), expected);
            assert_eq!(store.read("body").unwrap(), opening);
            let flushed = editor.flush_recovery().unwrap();
            assert_eq!(flushed.durable, editor.revision());
        }
        let mut recovered = store.open_editor("body").unwrap();
        assert_eq!(recovered.source_text(), expected);
        assert_eq!(recovered.display_text(), display);
        assert!(recovered.undo(recovered.revision()).unwrap().is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("body").unwrap(), expected);
        drop(recovered);
        assert_eq!(store.open_editor("body").unwrap().source_text(), expected);
    }
}
