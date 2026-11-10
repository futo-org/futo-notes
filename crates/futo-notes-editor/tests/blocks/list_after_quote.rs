//! #369: a list command, then the first keystroke, must not add a blank line.
use super::*;

/// Select the display caret, run `command`, type `Z` at the resulting caret;
/// returns (source after the command, source after typing, session).
fn apply_then_type(
    raw: &str,
    caret: usize,
    command: BlockCommand,
) -> (String, String, EditorSession) {
    let mut s = EditorSession::open(raw);
    s.select_with_affinity(s.revision(), range(caret, caret), Affinity::Backward)
        .unwrap();
    let sel = s.selection();
    s.block_command(s.revision(), sel, command, &mut |_| Ok(()))
        .unwrap_or_else(|e| panic!("{raw:?} {command:?}: {e:?}"));
    let after = s.source_text();
    let sel = s.selection();
    s.replace(s.revision(), sel, "Z", &mut |_| Ok(()))
        .unwrap_or_else(|e| panic!("{raw:?} {command:?} typing: {e:?}"));
    let typed = s.source_text();
    (after, typed, s)
}

#[test]
fn the_first_keystroke_after_a_block_command_next_to_a_quote_adds_no_blank_line() {
    use BlockCommand::{BulletList as B, OrderedList as O, Quote as Q, TaskList as T};
    // (source, display caret, command, source after the command, after typing Z)
    let cases: &[(&str, usize, BlockCommand, &str, &str)] = &[
        // Empty line right after a quote: the item stays outside the quote.
        ("> abc\n", 4, B, "> abc\n- ", "> abc\n- Z"),
        ("> abc\n", 4, O, "> abc\n1. ", "> abc\n1. Z"),
        ("> abc\n", 4, T, "> abc\n- [ ] ", "> abc\n- [ ] Z"),
        (
            "> abc\n> def\n",
            8,
            B,
            "> abc\n> def\n- ",
            "> abc\n> def\n- Z",
        ),
        ("> > abc\n", 4, B, "> > abc\n- ", "> > abc\n- Z"),
        ("> abc\r\n", 5, B, "> abc\r\n- ", "> abc\r\n- Z"),
        // Empty line before more text.
        ("> abc\n\nxyz", 4, B, "> abc\n- \nxyz", "> abc\n- Z\nxyz"),
        // Nonempty line right after a quote (lazy line): joins the quote.
        ("> abc\nxyz", 4, B, "> abc\n> - xyz", "> abc\n> - Zxyz"),
        ("> abc\nxyz", 4, O, "> abc\n> 1. xyz", "> abc\n> 1. Zxyz"),
        (
            "> abc\nxyz",
            4,
            T,
            "> abc\n> - [ ] xyz",
            "> abc\n> - [ ] Zxyz",
        ),
        // Inside a multi-line quote.
        (
            "> abc\n> def\n",
            5,
            B,
            "> abc\n> - def\n",
            "> abc\n> - dZef\n",
        ),
        ("> abc\n> def", 7, O, "> abc\n> 1. def", "> abc\n> 1. defZ"),
        (
            "> abc\n> def",
            7,
            T,
            "> abc\n> - [ ] def",
            "> abc\n> - [ ] defZ",
        ),
        // A quoted empty line gets its item inside the quote.
        ("> abc\n> ", 4, T, "> abc\n> - [ ] ", "> abc\n> - [ ] Z"),
        // The reverse: a quote on a list item or the line after a list.
        ("- abc\n", 4, Q, "- abc\n> ", "- abc\n> Z"),
        ("1. abc\n", 4, Q, "1. abc\n> ", "1. abc\n> Z"),
        ("- [ ] abc\n", 4, Q, "- [ ] abc\n> ", "- [ ] abc\n> Z"),
        ("- abc\n", 2, Q, "> abc\n", "> abZc\n"),
    ];
    for &(raw, caret, command, after, typed) in cases {
        let (got_after, got_typed, session) = apply_then_type(raw, caret, command);
        assert_eq!(got_after, after, "{raw:?} {command:?}: command");
        assert_eq!(got_typed, typed, "{raw:?} {command:?}: first keystroke");
        // The saved bytes reopen to the display the user is looking at.
        let reopened = EditorSession::open(&got_typed);
        assert_eq!(
            reopened.display_text(),
            session.display_text(),
            "{raw:?} {command:?}: reopen"
        );
    }
}

#[test]
fn undoing_the_first_keystroke_after_a_list_command_on_the_line_after_a_quote_restores_the_item() {
    for (command, item) in [
        (BlockCommand::BulletList, "> abc\n- "),
        (BlockCommand::OrderedList, "> abc\n1. "),
        (BlockCommand::TaskList, "> abc\n- [ ] "),
    ] {
        let (_, _, mut s) = apply_then_type("> abc\n", 4, command);
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), item, "{command:?}");
    }
}

#[test]
fn an_ime_commit_into_a_list_item_after_a_quote_adds_no_blank_line() {
    for (command, item) in [
        (BlockCommand::BulletList, "> abc\n- "),
        (BlockCommand::OrderedList, "> abc\n1. "),
        (BlockCommand::TaskList, "> abc\n- [ ] "),
    ] {
        let mut s = EditorSession::open("> abc\n");
        s.select_with_affinity(s.revision(), range(4, 4), Affinity::Backward)
            .unwrap();
        s.block_command(s.revision(), range(4, 4), command, &mut |_| Ok(()))
            .unwrap();
        assert_eq!(s.source_text(), item);
        let at = s.selection();
        s.compose(s.revision(), at, "日本").unwrap();
        s.commit_composition(s.revision(), None, &mut |_| Ok(()))
            .unwrap();
        assert_eq!(s.source_text(), format!("{item}日本"), "{command:?}");
    }
}
