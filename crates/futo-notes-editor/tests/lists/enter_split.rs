//! Enter splits that move an item's later rows into the new item.
use super::*;

/// Each display line's list role: `1.2` opens a depth-1 item numbered 2, `-1`
/// a depth-1 bullet, `1` continues a depth-1 item, `p` is outside any list.
fn list_rows(s: &EditorSession) -> Vec<String> {
    let text = s.display_text();
    let blocks = s
        .project(s.revision(), range(0, text.len()))
        .unwrap()
        .blocks;
    let mut at = 0;
    text.split('\n')
        .map(|line| {
            let block = blocks
                .iter()
                .find(|block| block.range.start.0 <= at && at <= block.range.end.0);
            at += line.len() + 1;
            match block.and_then(|block| block.list.as_ref()) {
                None => "p".to_owned(),
                Some(list) if !list.first => list.depth.to_string(),
                Some(list) => match list.number {
                    Some(number) => format!("{}.{number}", list.depth),
                    None => format!("-{}", list.depth),
                },
            }
        })
        .collect()
}

#[test]
fn enter_before_a_lazy_continuation_keeps_it_and_the_later_items_in_the_list() {
    // (source, caret at the end of this display line, expected source, list rows)
    for (raw, line, expected, rows) in [
        // The minimal repro: `3. b` became paragraph text.
        (
            "1. a\nlazy\n1. b",
            0,
            "1. a\n2. \n   lazy\n3. b",
            &["1.1", "1.2", "1", "1.3"][..],
        ),
        // A later `1.` after a blank line stays an item of the edited list.
        (
            "1. a\n2. b\nlazy\n\n1. one",
            1,
            "1. a\n2. b\n3. \n   lazy\n\n4. one",
            &["1.1", "1.2", "1.3", "1", "1", "1.4"][..],
        ),
        // The caret on a continuation line, and a bullet list.
        (
            "1. a\nlazy\nlazy2\n1. b",
            1,
            "1. a\nlazy\n2. \n   lazy2\n3. b",
            &["1.1", "1", "1.2", "1", "1.3"][..],
        ),
        (
            "- a\nlazy\n- b",
            0,
            "- a\n- \n  lazy\n- b",
            &["-1", "-1", "1", "-1"][..],
        ),
        // Quoted and nested lists.
        (
            "> 1. a\n> lazy\n> 1. b",
            0,
            "> 1. a\n> 2. \n>    lazy\n> 3. b",
            &["1.1", "1.2", "1", "1.3"][..],
        ),
        (
            "> 1. a\nlazy\n> 1. b",
            0,
            "> 1. a\n> 2. \n>    lazy\n> 3. b",
            &["1.1", "1.2", "1", "1.3"][..],
        ),
        (
            "1. x\n   1. a\n   lazy\n   1. b\n2. y",
            1,
            "1. x\n   1. a\n   2. \n      lazy\n   3. b\n2. y",
            &["1.1", "2.1", "2.2", "2", "2.3", "1.2"][..],
        ),
        // A marker that grows a digit moves the item's indented rows with it.
        (
            "9. a\n   cont\n1. b",
            0,
            "9. a\n10. \n    cont\n11. b",
            &["1.9", "1.10", "1", "1.11"][..],
        ),
        (
            "9. a\n   - nest\n1. b",
            0,
            "9. a\n10. \n    - nest\n11. b",
            &["1.9", "1.10", "-2", "1.11"][..],
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let display = s.display_text();
        let mut view = ReferenceView::new(&display);
        let at = display
            .split('\n')
            .take(line + 1)
            .map(|l| l.len() + 1)
            .sum::<usize>()
            - 1;
        view.apply(
            s.paragraph_key(
                s.revision(),
                range(at, at),
                ParagraphKey::Enter,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(list_rows(&s), rows, "{raw:?}");
        assert_eq!(view.text, s.display_text(), "{raw:?}");
        assert_eq!(s.selection(), range(at + 1, at + 1), "{raw:?}");
        assert_eq!(
            EditorSession::open(expected).display_text(),
            s.display_text()
        );
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw, "{raw:?} undo");
        assert_eq!(view.text, display);
    }
}

/// Presses Enter at `at` and checks the result reopens to the same display,
/// list rows and caret, then that Undo restores the exact source.
fn enter_at(raw: &str, at: usize, expected: &str, rows: &[&str], caret: usize) {
    let mut s = EditorSession::open(raw);
    let display = s.display_text();
    let mut view = ReferenceView::new(&display);
    view.apply(
        s.paragraph_key(
            s.revision(),
            range(at, at),
            ParagraphKey::Enter,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), expected, "{raw:?}");
    assert_eq!(list_rows(&s), rows, "{raw:?}");
    assert_eq!(view.text, s.display_text(), "{raw:?}");
    assert_eq!(s.selection(), range(caret, caret), "{raw:?}");
    assert_eq!(
        EditorSession::open(expected).display_text(),
        s.display_text(),
        "{raw:?}"
    );
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw, "{raw:?} undo");
    assert_eq!(view.text, display);
}

#[test]
fn enter_before_an_items_blank_line_moves_the_blank_above_the_new_item() {
    // An item begins with at most one blank line, so the empty new item takes
    // the item's later rows directly and the blank line stays above it.
    enter_at(
        "1. a\n\n   b",
        1,
        "1. a\n\n2. \n   b",
        &["1.1", "1", "1.2", "1"],
        3,
    );
    enter_at(
        "1. a\n\n   more\n2. b",
        1,
        "1. a\n\n2. \n   more\n3. b",
        &["1.1", "1", "1.2", "1", "1.3"],
        3,
    );
    enter_at(
        "1. a\n\n\n   b\n2. c",
        1,
        "1. a\n\n\n2. \n   b\n3. c",
        &["1.1", "1", "1", "1.2", "1", "1.3"],
        4,
    );
    enter_at(
        "> - a\n>\n>   b",
        1,
        "> - a\n>\n> - \n>   b",
        &["-1", "1", "-1", "1"],
        3,
    );
    // A blank line after the moved rows' first content is an ordinary loose
    // continuation and needs no move.
    enter_at(
        "1. a\n   x\n\n   b",
        1,
        "1. a\n2. \n   x\n\n   b",
        &["1.1", "1.2", "1", "1", "1"],
        2,
    );
}

#[test]
fn enter_in_formatting_that_crosses_the_caret_line_closes_and_reopens_it() {
    // (source, caret, expected source, display after, bold mask of that display)
    for (raw, at, expected, shown, mask) in [
        // The bold continues on a lazy line, which became literal `lazy** x`.
        (
            "1. **a\nlazy** x",
            1,
            "1. **a**\n2. \n   **lazy** x",
            "a\n\nlazy x",
            "b\n\nbbbb  ",
        ),
        // A split inside the bold, an indented continuation and a bullet.
        (
            "1. **ab\nlazy** x",
            1,
            "1. **a**\n2. **b**\n**lazy** x",
            "a\nb\nlazy x",
            "b\nb\nbbbb  ",
        ),
        (
            "- **a\n  cont** x",
            1,
            "- **a**\n- \n  **cont** x",
            "a\n\ncont x",
            "b\n\nbbbb  ",
        ),
        // The caret on a later row: the rows above close their bold too.
        (
            "1. **a\nb\nc** d",
            3,
            "1. **a**\n**b**\n2. \n   **c** d",
            "a\nb\n\nc d",
            "b\nb\n\nb  ",
        ),
        // Inside a quote.
        (
            "> 1. *a\n> lazy* x",
            1,
            "> 1. *a*\n> 2. \n>    *lazy* x",
            "a\n\nlazy x",
            "i\n\niiii  ",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(&s.display_text());
        view.apply(
            s.paragraph_key(
                s.revision(),
                range(at, at),
                ParagraphKey::Enter,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(s.display_text(), shown, "{raw:?}");
        assert_eq!(view.text, shown, "{raw:?}");
        let reopened = EditorSession::open(expected);
        assert_eq!(reopened.display_text(), shown, "{raw:?}");
        let formats = shown
            .char_indices()
            .map(|(at, c)| {
                if c == '\n' {
                    return '\n';
                }
                let p = reopened
                    .project(reopened.revision(), range(at, at + 1))
                    .unwrap();
                let has = |format| p.runs.iter().any(|run| run.formats.contains(&format));
                if has(InlineFormat::Bold) {
                    'b'
                } else if has(InlineFormat::Italic) {
                    'i'
                } else {
                    ' '
                }
            })
            .collect::<String>();
        assert_eq!(formats, mask, "{raw:?}");
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}

#[test]
fn enter_after_a_fence_first_item_uses_the_source_owned_list_marker() {
    for (opening, shown, caret, expected, display, after) in [
        (
            "- ```\n  r\n  ```\n  v",
            "r\nv",
            3,
            "- ```\n  r\n  ```\n  v\n- ",
            "r\nv\n",
            4,
        ),
        (
            "- a\n  ```\n  r\n  ```\n  v",
            "a\nr\nv",
            5,
            "- a\n  ```\n  r\n  ```\n  v\n- ",
            "a\nr\nv\n",
            6,
        ),
        (
            "9. ```\n   r\n   ```\n   v\n1. tail",
            "r\nv\ntail",
            3,
            "9. ```\n   r\n   ```\n   v\n10. \n11. tail",
            "r\nv\n\ntail",
            4,
        ),
        (
            "> 9. ```\r\n>    猫\r\n>    ```\r\n>    v\r\n> 1. tail",
            "猫\r\nv\r\ntail",
            6,
            "> 9. ```\r\n>    猫\r\n>    ```\r\n>    v\r\n> 10. \r\n> 11. tail",
            "猫\r\nv\r\n\r\ntail",
            8,
        ),
        (
            "- parent\n  - ```\n    r\n    ```\n    v\n  - tail",
            "parent\nr\nv\ntail",
            10,
            "- parent\n  - ```\n    r\n    ```\n    v\n  - \n  - tail",
            "parent\nr\nv\n\ntail",
            11,
        ),
        (
            "- ~~~lang\n  r\n  ~~~~~  \n  v",
            "r\nv",
            3,
            "- ~~~lang\n  r\n  ~~~~~  \n  v\n- ",
            "r\nv\n",
            4,
        ),
        (
            "9. a\n10. ```\n    r\n    ```\n    v\n11. tail",
            "a\nr\nv\ntail",
            1,
            "9. a\n10. \n11. ```\n    r\n    ```\n    v\n12. tail",
            "a\n\nr\nv\ntail",
            2,
        ),
    ] {
        for key in [ParagraphKey::Enter, ParagraphKey::ShiftEnter] {
            let mut s = EditorSession::open(opening);
            assert_eq!(s.display_text(), shown, "{opening:?}");
            let mut view = ReferenceView::new(shown);
            let selected = range(caret, caret);
            s.select(s.revision(), selected).unwrap();
            let mut accepted = 0;
            view.apply(
                s.paragraph_key(s.revision(), selected, key, &mut |_| {
                    accepted += 1;
                    Ok(())
                })
                .unwrap()
                .expect("Enter after a closed code child must split the item"),
            );
            assert_eq!(accepted, 1);
            assert_eq!(s.source_text(), expected, "{opening:?}");
            assert_eq!(view.text, display);
            assert_eq!(s.display_text(), display);
            assert_eq!(s.selection(), range(after, after));
            assert_eq!(EditorSession::open(expected).display_text(), display);
            view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), opening);
            assert_eq!(view.text, shown);
            assert_eq!(s.selection(), selected);
            view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), expected);
            assert_eq!(view.text, display);
        }
    }
}

#[test]
fn joining_after_a_fence_first_item_keeps_its_ordered_source_owner() {
    for (opening, shown, at, expected, display, after) in [
        (
            "9. ```\n   r\n   ```\n   v\n1. next\n1. tail",
            "r\nv\nnext\ntail",
            4,
            "9. ```\n   r\n   ```\n   vnext\n10. tail",
            "r\nvnext\ntail",
            3,
        ),
        (
            "9. a\n10. b\n11. ```\n    r\n    ```\n    v\n12. tail",
            "a\nb\nr\nv\ntail",
            2,
            "9. ab\n10. ```\n    r\n    ```\n    v\n11. tail",
            "ab\nr\nv\ntail",
            1,
        ),
    ] {
        let mut s = EditorSession::open(opening);
        let mut view = ReferenceView::new(shown);
        assert_eq!(s.display_text(), view.text);
        let selected = range(at, at);
        s.select(s.revision(), selected).unwrap();
        let mut accepted = 0;
        view.apply(
            s.paragraph_key(s.revision(), selected, ParagraphKey::Backspace, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, display);
        assert_eq!(s.selection(), range(after, after));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), opening);
        assert_eq!(s.selection(), selected);
    }
}

#[test]
fn enter_after_indented_code_retains_its_existing_origin_prefix() {
    for key in [ParagraphKey::Enter, ParagraphKey::ShiftEnter] {
        let opening = "-     r\n\n  uv";
        let expected = "-     r\n\n  u\n-     v";
        let mut s = EditorSession::open(opening);
        let mut view = ReferenceView::new("r\n\nuv");
        assert_eq!(s.display_text(), view.text);
        let selected = range(4, 4);
        s.select(s.revision(), selected).unwrap();
        let mut accepted = 0;
        view.apply(
            s.paragraph_key(s.revision(), selected, key, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, "r\n\nu\nv");
        assert_eq!(s.selection(), range(5, 5));
        assert!(s
            .project(s.revision(), range(5, 6))
            .unwrap()
            .blocks
            .iter()
            .any(|b| b.code));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), opening);
        assert_eq!(view.text, "r\n\nuv");
        assert_eq!(s.selection(), selected);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, "r\n\nu\nv");
    }
}

/// One structural key is one acceptance and exact history action, including
/// the source spelling and the supplied selection on Undo.
fn heading_list_enter(
    raw: &str,
    selected: DisplayRange,
    key: ParagraphKey,
    expected: &str,
    display: &str,
    after: usize,
    heading: u8,
) -> EditorSession {
    let mut s = EditorSession::open(raw);
    let opening = s.display_text();
    let mut view = ReferenceView::new(&opening);
    s.select(s.revision(), selected).unwrap();
    let mut accepted = 0;
    view.apply(
        s.paragraph_key(s.revision(), selected, key, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(accepted, 1, "{raw:?}");
    assert_eq!(s.source_text(), expected, "{raw:?}");
    assert_eq!(view.text, display);
    assert_eq!(s.display_text(), display);
    assert_eq!(s.selection(), range(after, after));
    assert_eq!(s.toolbar_state().heading.unwrap_or(0), heading);
    assert_eq!(EditorSession::open(expected).display_text(), display);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
    assert_eq!(view.text, opening);
    assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, display);
    assert_eq!(s.selection(), range(after, after));
    assert_eq!(s.toolbar_state().heading.unwrap_or(0), heading);
    s
}

#[test]
fn heading_list_enter_starts_the_next_item_without_a_heading() {
    for (raw, selected, expected, display, after) in [
        ("- # h", range(1, 1), "- # h\n- ", "h\n", 2),
        ("- ### ab", range(1, 1), "- ### a\n- b", "a\nb", 2),
        ("- ## abcd", range(1, 3), "- ## a\n- d", "a\nd", 2),
        // The caret's physical row is plain; the retained item origin owns H1.
        ("- # h\n  v", range(3, 3), "- # h\n  v\n- ", "h\nv\n", 4),
        (
            "> 9) ## 猫\r\n> 10) tail",
            range(3, 3),
            "> 9) ## 猫\r\n> 10) \r\n> 11) tail",
            "猫\r\n\r\ntail",
            5,
        ),
    ] {
        for key in [ParagraphKey::Enter, ParagraphKey::ShiftEnter] {
            heading_list_enter(raw, selected, key, expected, display, after, 0);
        }
    }
}

#[test]
fn heading_list_enter_carries_inline_marks_into_the_plain_item() {
    for key in [ParagraphKey::Enter, ParagraphKey::ShiftEnter] {
        let mut s = heading_list_enter(
            "- # **ab**",
            range(2, 2),
            key,
            "- # **ab**\n- ",
            "ab\n",
            3,
            0,
        );
        assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
        s.replace(s.revision(), s.selection(), "v", &mut |_| Ok(()))
            .unwrap();
        assert_eq!(s.source_text(), "- # **ab**\n- **v**");
        assert_eq!(s.display_text(), "ab\nv");
        assert_eq!(s.toolbar_state().heading, Some(0));
        assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), "- # **ab**\n- ");
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), "- # **ab**");
        assert_eq!(s.selection(), range(2, 2));
    }
}

#[test]
fn heading_list_enter_controls_keep_the_start_and_literal_task_hash() {
    for (raw, selected, expected, display, after, heading) in [
        ("- # ", range(0, 0), "# ", "", 0, 1),
        (
            "```\nr\n```\n\n- # ",
            range(3, 3),
            "```\nr\n```\n\n# ",
            "r\n\n",
            3,
            1,
        ),
        ("- # h", range(0, 0), "- \n- # h", "\nh", 1, 1),
        ("# h", range(1, 1), "# h\n", "h\n", 2, 0),
        ("- h", range(1, 1), "- h\n- ", "h\n", 2, 0),
        (
            "- [x] # h",
            range(3, 3),
            "- [x] \\# h\n- [ ] ",
            "# h\n",
            4,
            0,
        ),
    ] {
        for key in [ParagraphKey::Enter, ParagraphKey::ShiftEnter] {
            heading_list_enter(raw, selected, key, expected, display, after, heading);
        }
    }
}

#[test]
fn heading_list_enter_keeps_its_optional_closer_on_the_left() {
    for key in [ParagraphKey::Enter, ParagraphKey::ShiftEnter] {
        heading_list_enter(
            "- ## ab ##",
            range(2, 2),
            key,
            "- ## ab ##\n- ",
            "ab\n",
            3,
            0,
        );
    }
}
