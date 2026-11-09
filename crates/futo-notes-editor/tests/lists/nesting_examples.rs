//! Spelled Indent and Outdent examples: every repro of the MR !604 review, and
//! nested ordered lists at every depth.
use super::command_eligibility::{assert_no_op, caret_in, command, parsed_texts};
use super::*;

fn at_end(source: &str) -> EditorSession {
    let mut s = EditorSession::open(source);
    let end = s.display_text().len();
    s.select(s.revision(), range(end, end)).unwrap();
    s
}

fn type_text(s: &mut EditorSession, text: &str) {
    s.replace(s.revision(), s.selection(), text, &mut |_| Ok(()))
        .unwrap();
}

#[test]
fn enter_then_indent_then_typing_lands_in_the_new_nested_item() {
    for (start, nested) in [
        ("- a", "- a\n\n  - b"),
        ("* a", "* a\n\n  * b"),
        ("1. a", "1. a\n\n   1. b"),
        ("- [ ] a", "- [ ] a\n  - [ ] b"),
        ("- a\n- b", "- a\n- b\n\n  - c"),
        ("- a\n  - b", "- a\n  - b\n\n    - c"),
        ("> - a", "> - a\n>\n>   - b"),
        ("- a\n\t- b", "- a\n\t- b\n\n      - c"),
    ] {
        let mut s = at_end(start);
        let typed = if start.ends_with('b') { "c" } else { "b" };
        s.paragraph_key(
            s.revision(),
            s.selection(),
            ParagraphKey::Enter,
            &mut |_| Ok(()),
        )
        .unwrap();
        let entered = s.source_text();
        command(&mut s, BlockCommand::Indent)
            .unwrap_or_else(|| panic!("{start:?}: Indent did nothing"));
        type_text(&mut s, typed);
        assert_eq!(s.source_text(), nested, "{start:?}");
        // The parent keeps its text and its place; the typed text is the nested item's.
        let texts: Vec<_> = parsed_texts(&s.source_text())
            .into_iter()
            .map(|(text, depth, _)| (text, depth))
            .collect();
        let depth = if start.contains("- b") && start.starts_with("- a\n ") || start.contains("\t")
        {
            3
        } else {
            2
        };
        assert_eq!(texts.last(), Some(&(typed.to_string(), depth)), "{start:?}");
        assert_eq!(s.display_text().matches(typed).count(), 1, "{start:?}");
        for _ in 0..2 {
            s.undo(s.revision(), &mut |_| Ok(())).unwrap();
        }
        assert_eq!(s.source_text(), entered, "{start:?}");
    }
}

#[test]
fn indent_in_a_quoted_list_puts_the_tab_after_the_quote_markers() {
    for (source, caret, nested, un_nested) in [
        ("> - a\n> - b", "b", "> - a\n>   - b", "> - a\n> - b"),
        (
            "> > 1. a\n> > 2. b",
            "b",
            "> > 1. a\n> >    1. b",
            "> > 1. a\n> > 2. b",
        ),
        (
            "> - [ ] a\n> - [ ] b",
            "b",
            "> - [ ] a\n>   - [ ] b",
            "> - [ ] a\n> - [ ] b",
        ),
        ("> - a\n> \t- b", "b", "", "> - a\n> - b"),
    ] {
        let mut s = EditorSession::open(source);
        caret_in(&mut s, caret);
        if source.contains('\t') {
            command(&mut s, BlockCommand::Outdent).unwrap();
            assert_eq!(s.source_text(), un_nested, "{source:?}");
            continue;
        }
        command(&mut s, BlockCommand::Indent).unwrap();
        assert_eq!(s.source_text(), nested, "{source:?}");
        assert!(s.source_text().lines().all(|line| line.starts_with('>')));
        command(&mut s, BlockCommand::Outdent).unwrap();
        assert_eq!(s.source_text(), un_nested, "{source:?}");
    }
}

#[test]
fn an_empty_code_block_indents_its_empty_line_and_never_a_fence_line() {
    // (source, after Indent, after Outdent): in a list item the empty line takes
    // the item's indentation before the tab, and keeps it when the tab goes.
    for (source, tabbed, outdented) in [
        ("```\n\n```", "```\n\t\n```", "```\n\n```"),
        ("~~~\n\n~~~", "~~~\n\t\n~~~", "~~~\n\n~~~"),
        (
            "- a\n  ```\n\n  ```",
            "- a\n  ```\n  \t\n  ```",
            "- a\n  ```\n  \n  ```",
        ),
        ("> ```\n> \n> ```", "> ```\n> \t\n> ```", "> ```\n> \n> ```"),
    ] {
        let mut s = EditorSession::open(source);
        let at = s.display_text().len();
        s.select(s.revision(), range(at, at)).unwrap();
        assert!(s.toolbar_state().can_indent, "{source:?}");
        command(&mut s, BlockCommand::Indent).unwrap();
        assert_eq!(s.source_text(), tabbed, "{source:?}");
        let at = s.selection().start.0;
        type_text(&mut s, "z");
        assert!(s.source_text().contains("\tz"), "{source:?}");
        assert_eq!(
            s.source_text().matches("```").count(),
            source.matches("```").count()
        );
        s.undo(s.revision(), &mut |_| Ok(())).unwrap();
        s.select(s.revision(), range(at, at)).unwrap();
        command(&mut s, BlockCommand::Outdent).unwrap();
        assert_eq!(s.source_text(), outdented, "{source:?}");
    }
}

#[test]
fn outdent_with_mixed_leading_whitespace_un_nests_and_a_no_op_leaves_no_undo_step() {
    for source in ["- a\n  \t- b", "- a\n \t- b", "- a\n\t- b", "- a\n    - b"] {
        let mut s = EditorSession::open(source);
        caret_in(&mut s, "b");
        command(&mut s, BlockCommand::Outdent).unwrap();
        assert_eq!(s.source_text(), "- a\n- b", "{source:?}");
        s.undo(s.revision(), &mut |_| Ok(())).unwrap();
        assert_eq!(s.source_text(), source);
    }
    // Plain text, headings, quote lines and tables have nothing to indent.
    for source in [
        "para",
        "# head",
        "> quote",
        "| a |\n| - |\n| b |",
        "```\n```",
    ] {
        let mut s = EditorSession::open(source);
        for what in [BlockCommand::Indent, BlockCommand::Outdent] {
            assert_no_op(&mut s, what, source);
        }
    }
}

#[test]
fn nesting_an_ordered_item_renumbers_the_new_sub_list_and_the_siblings_that_remain() {
    let mut s = EditorSession::open("1. a\n2. b\n3. c\n4. d");
    caret_in(&mut s, "c");
    command(&mut s, BlockCommand::Indent).unwrap();
    assert_eq!(s.source_text(), "1. a\n2. b\n   1. c\n3. d");
    caret_in(&mut s, "b");
    command(&mut s, BlockCommand::Indent).unwrap();
    assert_eq!(s.source_text(), "1. a\n   1. b\n      1. c\n2. d");
    // Un-nesting renumbers the outer list and the children left behind.
    let mut s = EditorSession::open("1. a\n   1. b\n   2. c\n2. d");
    caret_in(&mut s, "b");
    command(&mut s, BlockCommand::Outdent).unwrap();
    assert_eq!(s.source_text(), "1. a\n2. b\n   1. c\n3. d");
}

#[test]
fn a_caret_after_a_surrogate_pair_keeps_its_utf16_offset_through_indent_and_outdent() {
    // (source, UTF-16 caret after the emoji, UTF-16 caret after Indent)
    for (source, caret, after) in [("- a\n- é😀b", 5, 5), ("```\né😀b\n```", 3, 4)] {
        let mut s = EditorSession::open(source);
        let utf16 = |at: usize| DisplayUtf16Range {
            start: DisplayUtf16Offset(at),
            end: DisplayUtf16Offset(at),
        };
        s.select_utf16(s.revision(), utf16(caret)).unwrap();
        let before = s.source_text();
        s.block_command_utf16(
            s.revision(),
            utf16(caret),
            BlockCommand::Indent,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            s.display_to_utf16(s.revision(), s.selection()).unwrap(),
            utf16(after)
        );
        s.undo(s.revision(), &mut |_| Ok(())).unwrap();
        assert_eq!(s.source_text(), before);
        assert_eq!(
            s.display_to_utf16(s.revision(), s.selection()).unwrap(),
            utf16(caret)
        );
    }
}

#[test]
fn nested_ordered_lists_nest_to_any_depth_and_mix_with_bullets_and_tasks() {
    // (source, item, source after Indent, the item's list depth after Indent)
    for (source, item, nested, depth) in [
        ("1. a\n2. b\n3. c", "b", "1. a\n   1. b\n2. c", 2),
        ("- x\n  1. a\n  2. b", "b", "- x\n  1. a\n     1. b", 3),
        ("1. x\n   - a\n   - b", "b", "1. x\n   - a\n     - b", 3),
        (
            "1. x\n   - [ ] a\n   - [ ] b",
            "b",
            "1. x\n   - [ ] a\n     - [ ] b",
            3,
        ),
        (
            "1. x\n   1. a\n   2. b",
            "b",
            "1. x\n   1. a\n      1. b",
            3,
        ),
        (
            "- x\n  - y\n    1. a\n    2. b",
            "b",
            "- x\n  - y\n    1. a\n       1. b",
            4,
        ),
        (
            "> 1. a\n> 2. b\n> 3. c",
            "b",
            "> 1. a\n>    1. b\n> 2. c",
            2,
        ),
        (
            "> 1. a\n>    1. b\n>    2. c",
            "c",
            "> 1. a\n>    1. b\n>       1. c",
            3,
        ),
    ] {
        let mut s = EditorSession::open(source);
        caret_in(&mut s, item);
        command(&mut s, BlockCommand::Indent).unwrap();
        assert_eq!(s.source_text(), nested, "{source:?}");
        let at = |source: &str| {
            parsed_texts(source)
                .into_iter()
                .find(|(text, ..)| text == item)
                .unwrap()
                .1
        };
        assert_eq!(at(&s.source_text()), depth, "{source:?}");
        s.undo(s.revision(), &mut |_| Ok(())).unwrap();
        assert_eq!(s.source_text(), source);
    }
}

#[test]
fn outdenting_a_nested_ordered_item_rejoins_the_parent_list_and_keeps_its_followers_nested() {
    for (source, item, outdented) in [
        (
            "1. a\n   1. b\n   2. c\n   3. d\n2. e",
            "b",
            "1. a\n2. b\n   1. c\n   2. d\n3. e",
        ),
        (
            "1. a\n   1. b\n   2. c\n   3. d\n2. e",
            "c",
            "1. a\n   1. b\n2. c\n   1. d\n3. e",
        ),
        (
            "- x\n  - y\n    1. a\n       1. b\n       2. c",
            "b",
            "- x\n  - y\n    1. a\n    2. b\n       1. c",
        ),
        (
            "> 1. a\n>    1. b\n>    2. c",
            "b",
            "> 1. a\n> 2. b\n>    1. c",
        ),
        // The item's own children and its followers form one list under it.
        (
            "1. a\n   1. b\n      1. b1\n   2. c",
            "b",
            "1. a\n2. b\n   1. b1\n   2. c",
        ),
        (
            "- a\n  - b\n    - b1\n  - c",
            "b",
            "- a\n- b\n  - b1\n  - c",
        ),
        (
            "1. a\n   1. b\n      1. b1\n         1. b2\n      2. b3\n   2. c\n      1. c1\n   3. d",
            "b",
            "1. a\n2. b\n   1. b1\n      1. b2\n   2. b3\n   3. c\n      1. c1\n   4. d",
        ),
    ] {
        let mut s = EditorSession::open(source);
        caret_in(&mut s, item);
        command(&mut s, BlockCommand::Outdent).unwrap();
        assert_eq!(s.source_text(), outdented, "{source:?}");
        // The item is one level out, and each follower is one level deeper than it.
        let depths: Vec<_> = parsed_texts(&s.source_text())
            .into_iter()
            .map(|(text, depth, _)| (text, depth))
            .collect();
        let before: Vec<_> = parsed_texts(source)
            .into_iter()
            .map(|(text, depth, _)| (text, depth))
            .collect();
        let moved = before.iter().position(|(text, _)| text == item).unwrap();
        assert_eq!(depths[moved].1, before[moved].1 - 1, "{source:?}");
        s.undo(s.revision(), &mut |_| Ok(())).unwrap();
        assert_eq!(s.source_text(), source);
    }
}

#[test]
fn a_selection_across_an_items_code_block_nests_the_whole_item() {
    let select = |s: &mut EditorSession, from: &str, to: &str| {
        let text = s.display_text();
        let (a, b) = (text.find(from).unwrap(), text.find(to).unwrap() + 1);
        s.select(s.revision(), range(a, b)).unwrap();
    };
    let fenced = "- a\n- b\n  ```\n  x\n  ```\n- c";
    let nested = "- a\n  - b\n    ```\n    x\n    ```\n  - c";
    for (source, to, indented, outdented) in [
        (fenced, "c", Some(nested), None),
        (fenced, "x", Some("- a\n  - b\n    ```\n    x\n    ```\n- c"), None),
        (nested, "c", None, Some(fenced)),
    ] {
        let mut s = EditorSession::open(source);
        select(&mut s, "b", to);
        let state = s.toolbar_state();
        assert_eq!(
            (state.can_indent, state.can_outdent),
            (indented.is_some(), outdented.is_some()),
            "{source:?}"
        );
        let (what, expected) = match (indented, outdented) {
            (Some(expected), _) => (BlockCommand::Indent, expected),
            (_, Some(expected)) => (BlockCommand::Outdent, expected),
            _ => unreachable!(),
        };
        command(&mut s, what).unwrap();
        assert_eq!(s.source_text(), expected, "{source:?} {to:?}");
        s.undo(s.revision(), &mut |_| Ok(())).unwrap();
        assert_eq!(s.source_text(), source);
    }
}
