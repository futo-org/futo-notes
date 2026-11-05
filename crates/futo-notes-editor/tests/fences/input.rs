use super::*;

#[test]
fn literal_code_input_and_enter_keep_fence_and_neighbors_exact_through_history() {
    let source = "~~~js\r\nab\r\n~~~~ \r\n\n__tail__";
    let mut session = EditorSession::open(source);
    let mut view = ReferenceView::new("ab\r\n\ntail");
    session.select(session.revision(), range(1, 1)).unwrap();
    view.apply(
        session
            .replace(
                session.revision(),
                range(1, 1),
                "*# [[x]] &amp;",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "~~~js\r\na*# [[x]] &amp;b\r\n~~~~ \r\n\n__tail__"
    );
    assert_eq!(view.text, "a*# [[x]] &amp;b\r\n\ntail");
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), source);
    assert_eq!(view.text, "ab\r\n\ntail");
    view.apply(
        session
            .paragraph_key(
                session.revision(),
                range(1, 1),
                ParagraphKey::Enter,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "~~~js\r\na\r\nb\r\n~~~~ \r\n\n__tail__"
    );
    assert_eq!(view.text, "a\r\nb\r\n\ntail");
    assert_eq!(session.selection(), range(3, 3));
}

#[test]
fn empty_fence_has_a_hidden_structural_caret_and_accepts_literal_text() {
    for opening in ["```js\n```", "~~~\n~~~", "```js"] {
        let mut session = EditorSession::open(opening);
        let mut view = ReferenceView::new("");
        assert_eq!(session.display_text(), "");
        view.apply(
            session
                .replace(session.revision(), range(0, 0), "# x", &mut |_| Ok(()))
                .unwrap(),
        );
        let expected = match opening {
            "```js\n```" => "```js\n# x\n```",
            "~~~\n~~~" => "~~~\n# x\n~~~",
            _ => "```js\n# x",
        };
        assert_eq!(session.source_text(), expected);
        assert_eq!(view.text, "# x");
    }
}

#[test]
fn code_delimiters_and_nested_enter_stay_inside_the_original_block() {
    for (source, shown, selected, inserted, expected, display) in [
        (
            "~~~js\na\n~~~",
            "a",
            range(0, 0),
            "*",
            "~~~js\n*a\n~~~",
            "*a",
        ),
        (
            "```js\na\n```",
            "a",
            range(0, 0),
            "```\n",
            "````js\n```\na\n````",
            "```\na",
        ),
        (
            "> ~~~js\n> ab\n> ~~~",
            "ab",
            range(1, 1),
            "\n",
            "> ~~~js\n> a\n> b\n> ~~~",
            "a\nb",
        ),
    ] {
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new(shown);
        assert_eq!(session.display_text(), shown);
        view.apply(
            session
                .replace_action(
                    session.revision(),
                    selected,
                    inserted,
                    InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected);
        assert_eq!(view.text, display);
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), source);
    }
}

#[test]
fn indented_fences_lengthen_only_their_delimiters_for_literal_closing_text() {
    let mut session = EditorSession::open("   ~~~Rust\n   a\n   ~~~~  \n\nend");
    let mut view = ReferenceView::new("a\n\nend");
    assert_eq!(session.display_text(), view.text);
    view.apply(
        session
            .replace_action(
                session.revision(),
                range(0, 0),
                "~~~\n",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "   ~~~~Rust\n   ~~~\n   a\n   ~~~~  \n\nend"
    );
    assert_eq!(view.text, "~~~\na\n\nend");
}

#[test]
fn empty_native_input_does_not_add_a_body_line_or_respell_an_empty_fence() {
    for source in ["```js\n```", "~~~js", "~~~\n~~~\nafter"] {
        let mut session = EditorSession::open(source);
        let display = session.display_text();
        let mut view = ReferenceView::new(&display);
        view.apply(
            session
                .replace(session.revision(), range(0, 0), "", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(session.source_text(), source);
        assert_eq!(view.text, display);
    }
}

#[test]
fn indented_delimiter_text_that_cannot_close_code_does_not_respell_fences() {
    let mut session = EditorSession::open("```js\na\n```  ");
    let mut view = ReferenceView::new("a");
    view.apply(
        session
            .replace_action(
                session.revision(),
                range(0, 0),
                "    ```\n",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(session.source_text(), "```js\n    ```\na\n```  ");
    assert_eq!(view.text, "    ```\na");
}

#[test]
fn a_longer_original_closer_is_never_shortened_during_delimiter_repair() {
    let mut session = EditorSession::open("```js\na\n``````  ");
    let mut view = ReferenceView::new("a");
    view.apply(
        session
            .replace_action(
                session.revision(),
                range(0, 0),
                "```\n",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(session.source_text(), "````js\n```\na\n``````  ");
    assert_eq!(view.text, "```\na");
}

#[test]
fn a_typed_opener_in_a_list_item_keeps_the_fence_and_later_rows_in_the_item() {
    // The body and closing lines take the item's content column; at column
    // zero the closer ended the item and opened a fence over its later rows.
    for (raw, at, expected, shown) in [
        (
            "- a\n- \n  more",
            2,
            "- a\n- ```q\n  \n  ```\n  more",
            "a\n\nmore",
        ),
        ("1. \n   more", 0, "1. ```q\n   \n   ```\n   more", "\nmore"),
        (
            "> - \n>   more",
            0,
            "> - ```q\n>   \n>   ```\n>   more",
            "\nmore",
        ),
        (
            "- a\r\n- \r\n",
            3,
            "- a\r\n- ```q\r\n  \r\n  ```\r\n",
            "a\r\n",
        ),
    ] {
        let mut session = EditorSession::open(raw);
        let mut view = ReferenceView::new(&session.display_text());
        session.select(session.revision(), range(at, at)).unwrap();
        for typed in ["`", "`", "`", "q", " "] {
            view.apply(
                session
                    .replace(session.revision(), session.selection(), typed, &mut |_| {
                        Ok(())
                    })
                    .unwrap(),
            );
        }
        assert_eq!(session.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, shown, "{raw:?}");
        assert_eq!(EditorSession::open(expected).display_text(), shown);
        // The caret is on the empty code line; the opener line is hidden.
        assert_eq!(session.selection(), range(at, at), "{raw:?}");
    }
}

#[test]
fn a_typed_opener_in_a_table_row_or_task_stays_literal_text() {
    // Space after ``` at a row's start converted the row into a code block,
    // turning the rest of the table into code; in a task it left the opener
    // as text and an empty fence below it.
    for (raw, after) in [
        ("| a | b |\n|---|---|\n| c | d |\n", "| c"),
        ("- [ ] task\n- [ ] \n- [x] done\n", ""),
    ] {
        let mut session = EditorSession::open(raw);
        let mut view = ReferenceView::new(&session.display_text());
        let at = if after.is_empty() {
            session.display_text().find("\n\n").unwrap() + 1
        } else {
            session.display_text().find(after).unwrap()
        };
        session.select(session.revision(), range(at, at)).unwrap();
        for typed in ["`", "`", "`", "q", " "] {
            view.apply(
                session
                    .replace(session.revision(), session.selection(), typed, &mut |_| {
                        Ok(())
                    })
                    .unwrap(),
            );
        }
        let source = session.source_text();
        assert!(!source.contains("q\n"), "{source:?}");
        assert!(view.text.contains("```q "), "{:?}", view.text);
        assert_eq!(view.text, session.display_text());
        assert_eq!(EditorSession::open(&source).display_text(), view.text);
    }
}
