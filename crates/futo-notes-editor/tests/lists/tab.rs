//! Tab and Shift+Tab in a list item are the Indent and Outdent commands.
use super::*;

#[test]
fn list_tab_is_the_indent_command_and_shift_tab_the_outdent_command() {
    for (raw, key, caret, expected) in [
        ("- a\n- b", ParagraphKey::Tab, (3, 3), "- a\n\t- b"),
        (
            "1. a\n2. b\n3. c",
            ParagraphKey::Tab,
            (3, 3),
            "1. a\n\t1. b\n2. c",
        ),
        (
            "- [ ] a\n- [x] b",
            ParagraphKey::Tab,
            (3, 3),
            "- [ ] a\n\t- [x] b",
        ),
        ("> - a\n> - b", ParagraphKey::Tab, (3, 3), "> - a\n> \t- b"),
        ("- a\n  - b", ParagraphKey::ShiftTab, (3, 3), "- a\n- b"),
        (
            "1. a\n   1. b\n2. c",
            ParagraphKey::ShiftTab,
            (3, 3),
            "1. a\n2. b\n3. c",
        ),
        // A new empty item nests under its sibling's text.
        ("- a\n- ", ParagraphKey::Tab, (2, 2), "- a\n\t- "),
        ("- a\n  - ", ParagraphKey::ShiftTab, (2, 2), "- a\n- "),
        ("- a\n\n  - ", ParagraphKey::ShiftTab, (3, 3), "- a\n\n- "),
        // A selection moves every selected item, as the button does.
        (
            "- a\n- b\n- c",
            ParagraphKey::Tab,
            (2, 5),
            "- a\n\t- b\n\t- c",
        ),
        // Outdent takes a tab off tab-indented items and a level of spaces off older ones.
        ("- a\n\t- b", ParagraphKey::ShiftTab, (3, 3), "- a\n- b"),
        (
            "1. a\n\t1. b\n2. c",
            ParagraphKey::ShiftTab,
            (3, 3),
            "1. a\n2. b\n3. c",
        ),
    ]
    .map(|(raw, key, (a, b), expected)| (raw, key, range(a, b), expected))
    {
        let mut s = EditorSession::open(raw);
        s.select(s.revision(), caret).unwrap();
        let state = s.toolbar_state();
        assert!(
            if key == ParagraphKey::Tab {
                state.can_indent
            } else {
                state.can_outdent
            },
            "{raw:?}"
        );
        let mut accepted = 0;
        s.paragraph_key(s.revision(), caret, key, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(accepted, 1);
        // The same source the toolbar command writes.
        let mut button = EditorSession::open(raw);
        let command = if key == ParagraphKey::Tab {
            BlockCommand::Indent
        } else {
            BlockCommand::Outdent
        };
        button.select(button.revision(), caret).unwrap();
        button
            .block_command(button.revision(), caret, command, &mut |_| Ok(()))
            .unwrap();
        assert_eq!(button.source_text(), expected, "{raw:?}");
        assert_eq!(s.selection(), button.selection(), "{raw:?}");
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), raw, "{raw:?} undo");
    }
}

#[test]
fn tab_where_the_indent_command_is_unavailable_leaves_the_note_unchanged() {
    for (raw, key, caret) in [
        // The first item has no sibling to nest under.
        ("- a\n- b", ParagraphKey::Tab, 1),
        ("1. a\n2. b", ParagraphKey::Tab, 1),
        // The note's last empty root item cannot outdent.
        ("- a\n- ", ParagraphKey::ShiftTab, 2),
        // Tab outside lists and code indents nothing and inserts no tab.
        ("plain text", ParagraphKey::Tab, 3),
        ("> quoted", ParagraphKey::Tab, 3),
        ("> quoted", ParagraphKey::ShiftTab, 3),
        ("# Heading", ParagraphKey::Tab, 3),
    ] {
        let mut s = EditorSession::open(raw);
        let caret = range(caret, caret);
        s.select(s.revision(), caret).unwrap();
        let revision = s.revision();
        let result = s
            .paragraph_key(revision, caret, key, &mut |_| Ok(()))
            .unwrap();
        assert!(result.is_none(), "{raw:?} {key:?}");
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.revision(), revision);
        assert!(!s.toolbar_state().can_undo);
    }
}
