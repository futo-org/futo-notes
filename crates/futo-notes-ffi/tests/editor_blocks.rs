mod support;
use futo_notes_ffi::{EditorBlockCommand, EditorParagraphKey, EditorUtf16Range, NoteStore};
use support::{path_string, TempTree};
#[test]
fn native_block_commands_project_structure_and_recover_exact_source() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("blocks".into(), "".into(), "😀ab\r\ntail  \r\n".into())
        .unwrap();
    let session = store.open_editor("blocks".into()).unwrap();
    let heading = session
        .block_command_utf16(
            0,
            EditorUtf16Range { start: 2, end: 2 },
            EditorBlockCommand::Heading { level: 6 },
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "###### 😀ab\r\ntail  \r\n");
    assert_eq!(heading.projection.blocks[0].heading, 6);
    session
        .paragraph_key_utf16(
            1,
            EditorUtf16Range { start: 3, end: 3 },
            EditorParagraphKey::Enter,
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        session.source_text().unwrap(),
        "###### 😀a\nb\r\ntail  \r\n"
    );
    session.undo(2).unwrap().unwrap();
    session.redo(3).unwrap().unwrap();
    session.flush_recovery().unwrap();
    session.detach().unwrap();
    let recovered = store.open_editor("blocks".into()).unwrap();
    assert_eq!(
        recovered.source_text().unwrap(),
        "###### 😀a\nb\r\ntail  \r\n"
    );
    recovered.checkpoint().unwrap();
    assert_eq!(
        store.read("blocks".into()).unwrap(),
        "###### 😀a\nb\r\ntail  \r\n"
    );
}

#[test]
fn native_block_regressions_preserve_visible_text_and_recover_exact_source() {
    for (opening, command, expected, shown) in [
        (
            "   foo",
            EditorBlockCommand::Heading { level: 2 },
            "## &#32;  foo",
            "   foo",
        ),
        (
            "> ## Title ##",
            EditorBlockCommand::Quote,
            "> Title",
            "Title",
        ),
        (
            "> foo\n> bar\n> ===",
            EditorBlockCommand::Heading { level: 0 },
            "> foo\n> bar",
            "foo\nbar",
        ),
    ] {
        let tree = TempTree::new();
        std::fs::create_dir_all(tree.path("vault")).unwrap();
        let store = NoteStore::new(path_string(&tree.path("vault")));
        store
            .create_note("blocks".into(), "".into(), opening.into())
            .unwrap();
        let session = store.open_editor("blocks".into()).unwrap();
        assert_eq!(session.display_text().unwrap(), shown);
        session
            .block_command_utf16(0, EditorUtf16Range { start: 0, end: 0 }, command)
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text().unwrap(), expected);
        assert_eq!(session.display_text().unwrap(), shown);
        session.undo(1).unwrap().unwrap();
        assert_eq!(session.source_text().unwrap(), opening);
        session.redo(2).unwrap().unwrap();
        session.flush_recovery().unwrap();
        session.detach().unwrap();
        let recovered = store.open_editor("blocks".into()).unwrap();
        assert_eq!(recovered.source_text().unwrap(), expected);
        assert_eq!(recovered.display_text().unwrap(), shown);
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("blocks".into()).unwrap(), expected);
    }
}

#[test]
fn native_setext_physical_ownership_and_heading_enter_recover_exactly() {
    for (opening, shown, action, start, end, expected, display, caret) in [
        ("#x\n=", "#x", "text", 0, 2, "#x", "#x", 2),
        (
            "> x\n> y\n> =",
            "x\ny",
            "indent",
            0,
            3,
            "> > x\n> > y\n> > =",
            "x\ny",
            3,
        ),
        (
            "> > x\r\n> > y\r\n> > ---",
            "x\r\ny",
            "outdent",
            0,
            4,
            "> x\r\n> y\r\n> ---",
            "x\r\ny",
            4,
        ),
        (
            "> > 猫🦊\r\n> > e\u{301}\r\n> > ===",
            "猫🦊\r\ne\u{301}",
            "enter",
            5,
            5,
            "> > 猫🦊\r\n> > ===\r\n\n> > e\u{301}",
            "猫🦊\r\n\ne\u{301}",
            6,
        ),
        ("> # x", "x", "enter", 0, 1, "> # \n> ", "\n", 1),
        ("> x\n> =", "x", "enter", 0, 1, "> # \n> ", "\n", 1),
        ("> x\n> =", "x", "delete", 0, 1, "> # ", "", 0),
    ] {
        let tree = TempTree::new();
        std::fs::create_dir_all(tree.path("vault")).unwrap();
        let store = NoteStore::new(path_string(&tree.path("vault")));
        store
            .create_note("setext".into(), "".into(), opening.into())
            .unwrap();
        let session = store.open_editor("setext".into()).unwrap();
        assert_eq!(session.display_text().unwrap(), shown);
        let selected = EditorUtf16Range { start, end };
        session.select_utf16(0, selected).unwrap();
        let change = match action {
            "enter" => session
                .paragraph_key_utf16(0, selected, EditorParagraphKey::Enter)
                .unwrap()
                .unwrap(),
            "delete" => session.replace_utf16(0, selected, vec![]).unwrap(),
            _ => {
                let command = match action {
                    "text" => EditorBlockCommand::Heading { level: 0 },
                    "indent" => EditorBlockCommand::Indent,
                    "outdent" => EditorBlockCommand::Outdent,
                    _ => unreachable!(),
                };
                session
                    .block_command_utf16(0, selected, command)
                    .unwrap()
                    .unwrap()
            }
        };
        assert_eq!(session.source_text().unwrap(), expected);
        assert_eq!(session.display_text().unwrap(), display);
        assert_eq!(
            session.display_to_utf16(1, change.selection).unwrap().end,
            caret
        );
        session.undo(1).unwrap().unwrap();
        assert_eq!(session.source_text().unwrap(), opening);
        session.redo(2).unwrap().unwrap();
        assert_eq!(session.source_text().unwrap(), expected);
        session.flush_recovery().unwrap();
        session.detach().unwrap();
        let recovered = store.open_editor("setext".into()).unwrap();
        assert_eq!(recovered.source_text().unwrap(), expected);
        assert_eq!(recovered.display_text().unwrap(), display);
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("setext".into()).unwrap(), expected);
    }
}

#[test]
fn native_complete_body_and_returned_caret_input_recover_exactly() {
    for (opening, shown, action, start, end, expected, display, followup) in [
        (
            "> a\n> b\n> =",
            "a\nb",
            "divider",
            0,
            0,
            "> ---\n> \n> a\n> b\n> =",
            "\u{fffc}\n\na\nb",
            false,
        ),
        (
            "> a\n> b\n> =",
            "a\nb",
            "divider",
            0,
            3,
            "> ---\n> ",
            "\u{fffc}\n",
            false,
        ),
        (
            "> 猫🦊\n> e\u{301}z\n> ===",
            "猫🦊\ne\u{301}z",
            "divider",
            7,
            7,
            "> 猫🦊\n> e\u{301}z\n> ===\n> ***\n> ",
            "猫🦊\ne\u{301}z\n\u{fffc}\n",
            false,
        ),
        (
            "a\nb\n===",
            "a\nb",
            "heading",
            0,
            3,
            "### a b",
            "a b",
            false,
        ),
        (
            "> ab ##\n> cd ###\n> ===",
            "ab ##\ncd ###",
            "heading",
            0,
            12,
            "> ### ab ## cd \\###",
            "ab ## cd ###",
            false,
        ),
        ("## x y", "x y", "delete", 0, 0, "## &#32;y", " y", false),
        (
            "## # ab",
            "# ab",
            "delete",
            0,
            0,
            "## &#32;ab",
            " ab",
            false,
        ),
        ("#x\n=", "#x", "backspace", 2, 2, "\\#\n=", "#", false),
        ("## x", "x", "space", 0, 1, "## &#32;", " ", false),
        ("x\n=", "x", "newline", 0, 1, "# \n", "\n", false),
        (
            "> __ab\n> cd__",
            "ab\ncd",
            "enter",
            1,
            1,
            "> __a__\n>\n> __!b__\n> __cd__",
            "a\n\n!b\ncd",
            true,
        ),
        (
            "> __ab\n> cd__\n> ===",
            "ab\ncd",
            "enter",
            1,
            1,
            "> __a__\n> ===\n> __!b\n> cd__",
            "a\n!b\ncd",
            true,
        ),
        (
            "> `ab`\n> `cd`\n> ---",
            "ab\ncd",
            "delete",
            3,
            3,
            "> `ab`\n> `!d`\n> ---",
            "ab\n!d",
            true,
        ),
        (
            "> ab\ncd\n> ===",
            "ab\ncd",
            "divider",
            1,
            4,
            "> a\n> ===\n> ***\n> \n> d\n> ===",
            "a\n\u{fffc}\n\nd",
            false,
        ),
        (
            "> ## # ab ##\n> ## cd ###",
            "# ab\ncd",
            "delete",
            0,
            7,
            "> ##  ! ###",
            "!",
            true,
        ),
        ("> ab\n> ===", "ab", "space", 0, 2, "> # &#32;", " ", false),
    ] {
        let tree = TempTree::new();
        std::fs::create_dir_all(tree.path("vault")).unwrap();
        let store = NoteStore::new(path_string(&tree.path("vault")));
        store
            .create_note("body".into(), "".into(), opening.into())
            .unwrap();
        let session = store.open_editor("body".into()).unwrap();
        let selected = EditorUtf16Range { start, end };
        session.select_utf16(0, selected).unwrap();
        let change = match action {
            "heading" | "divider" => session
                .block_command_utf16(
                    0,
                    selected,
                    if action == "heading" {
                        EditorBlockCommand::Heading { level: 3 }
                    } else {
                        EditorBlockCommand::Divider
                    },
                )
                .unwrap()
                .unwrap(),
            "space" | "newline" => session
                .replace_utf16_action(
                    0,
                    selected,
                    if action == "space" {
                        vec![32]
                    } else {
                        vec![10]
                    },
                    futo_notes_ffi::EditorInputAction::Isolated,
                )
                .unwrap(),
            _ => session
                .paragraph_key_utf16(
                    0,
                    selected,
                    match action {
                        "enter" => EditorParagraphKey::Enter,
                        "delete" => EditorParagraphKey::Delete,
                        "backspace" => EditorParagraphKey::Backspace,
                        _ => unreachable!(),
                    },
                )
                .unwrap()
                .unwrap(),
        };
        let mut view = shown.to_owned();
        view.replace_range(
            change.range.start as usize..change.range.end as usize,
            &change.inserted,
        );
        if followup {
            let caret = session.display_to_utf16(1, change.selection).unwrap();
            let next = session
                .replace_utf16_action(
                    1,
                    caret,
                    vec![33],
                    futo_notes_ffi::EditorInputAction::Isolated,
                )
                .unwrap();
            view.replace_range(
                next.range.start as usize..next.range.end as usize,
                &next.inserted,
            );
        }
        assert_eq!(view, display);
        assert_eq!(session.source_text().unwrap(), expected);
        session.undo(session.revision().unwrap()).unwrap().unwrap();
        if followup {
            session.undo(session.revision().unwrap()).unwrap().unwrap();
        }
        assert_eq!(session.source_text().unwrap(), opening);
        session.redo(session.revision().unwrap()).unwrap().unwrap();
        if followup {
            session.redo(session.revision().unwrap()).unwrap().unwrap();
        }
        assert_eq!(session.source_text().unwrap(), expected);
        session.flush_recovery().unwrap();
        session.detach().unwrap();
        let recovered = store.open_editor("body".into()).unwrap();
        assert_eq!(recovered.source_text().unwrap(), expected);
        assert_eq!(recovered.display_text().unwrap(), display);
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("body".into()).unwrap(), expected);
    }
}
