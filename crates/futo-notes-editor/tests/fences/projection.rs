use super::*;

#[test]
fn fences_hide_only_structure_and_keep_exact_opaque_contents() {
    for (source, display) in [
        (
            "~~~~ c++ extra\r\n**a** [[x]] #tag &amp;\r\n~~~~~  \r\n",
            "**a** [[x]] #tag &amp;",
        ),
        ("```rust\na\n\nb\n```", "a\n\nb"),
        ("```unknown\n*raw*\0", "*raw*\0"),
    ] {
        let session = EditorSession::open(source);
        assert_eq!(session.source_text(), source);
        assert_eq!(session.display_text(), display);
        let projection = session
            .project(session.revision(), range(0, display.len()))
            .unwrap();
        assert!(projection.runs.iter().all(|run| run.formats.is_empty()));
        assert!(projection.blocks.iter().any(|block| block.code));
        let expected_language = if source.starts_with("~~~~") {
            "c++"
        } else if source.starts_with("```rust") {
            "rust"
        } else {
            "unknown"
        };
        assert!(projection
            .blocks
            .iter()
            .filter(|block| block.code)
            .all(|block| block.language.as_deref() == Some(expected_language)));
    }
}

#[test]
fn empty_code_before_prose_keeps_a_distinct_body_caret_and_projection() {
    let original = "```js\n```\nafter";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("\nafter");
    assert_eq!(session.display_text(), view.text);
    view.apply(
        session
            .replace(session.revision(), range(0, 0), "# x", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), "```js\n# x\n```\nafter");
    assert_eq!(view.text, "# x\nafter");
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, "\nafter");
}

#[test]
fn code_list_marker_prefix_is_retained_at_a_rendering_window_start() {
    let mut missing = Vec::new();
    for (label, source, shown, start, depth, number) in [
        ("note start", "- ```\n  r\n  ```\n  v", "r\nv", 0, 1, None),
        (
            "clipped ordered item",
            "9. a\n10. ```\n    r\n    ```\n    v\n11. tail",
            "a\nr\nv\ntail",
            2,
            1,
            Some(10),
        ),
        (
            "quoted CRLF Unicode",
            "> - ```\r\n>   猫\r\n>   ```\r\n>   v",
            "猫\r\nv",
            0,
            1,
            None,
        ),
        (
            "nested item",
            "- parent\n  - ```\n    r\n    ```\n    v",
            "parent\nr\nv",
            7,
            2,
            None,
        ),
    ] {
        let session = EditorSession::open(source);
        assert_eq!(session.display_text(), shown);
        let projection = session
            .project(session.revision(), range(start, shown.len()))
            .unwrap();
        assert_eq!(projection.text, &shown[start..]);
        let marker = projection.blocks.iter().find(|block| {
            block.code
                && block.range == range(start, start)
                && block
                    .list
                    .as_ref()
                    .is_some_and(|list| list.first && list.depth == depth && list.number == number)
        });
        if marker.is_none() {
            missing.push((label, projection.blocks));
        }
        assert_eq!(session.source_text(), source);
        assert_eq!(session.revision().0, 0);
    }
    assert!(
        missing.is_empty(),
        "hidden first-item marker missing: {missing:#?}"
    );
}

#[test]
fn code_list_marker_prefix_follows_the_first_rendered_body_row_only() {
    for (source, shown, from, to, expected) in [
        ("- ```\n  run\n  ```\n  v", "run\nv", 1, 2, vec![0]),
        ("- ```\n  run\n  ```\n  v", "run\nv", 3, 3, vec![0]),
        ("- ```\n  \n  ```", "", 0, 0, vec![0]),
        ("- ```\n  r", "r", 0, 1, vec![0]),
        ("- ```\n  r\n  s\n  ```\n  v", "r\ns\nv", 2, 3, vec![]),
        (
            "- lead\n  ```\n  code\n  ```\n  follow",
            "lead\ncode\nfollow",
            5,
            9,
            vec![],
        ),
    ] {
        let session = EditorSession::open(source);
        assert_eq!(session.display_text(), shown);
        let projection = session
            .project(session.revision(), range(from, to))
            .unwrap();
        assert_eq!(projection.text, &shown[from..to]);
        let markers = projection
            .blocks
            .iter()
            .filter_map(|block| {
                (block.code && block.list.as_ref().is_some_and(|list| list.first))
                    .then_some(block.range.start.0)
            })
            .collect::<Vec<_>>();
        assert_eq!(markers, expected, "{source:?} range{from}..{to}");
    }
}

#[test]
fn code_list_marker_prefix_controls_keep_existing_first_and_continuation_roles() {
    for (source, shown, at, number, code) in [
        (
            "9. a\n10. ```\n    r\n    ```\n    v\n11. tail",
            "a\nr\nv\ntail",
            2,
            Some(10),
            true,
        ),
        (
            "- lead\n  ```\n  code\n  ```\n  follow",
            "lead\ncode\nfollow",
            0,
            None,
            false,
        ),
    ] {
        let session = EditorSession::open(source);
        assert_eq!(session.display_text(), shown);
        let projection = session
            .project(session.revision(), range(0, shown.len()))
            .unwrap();
        let first = projection
            .blocks
            .iter()
            .filter(|block| {
                block.code == code
                    && block.range.start.0 == at
                    && block
                        .list
                        .as_ref()
                        .is_some_and(|list| list.first && list.number == number)
            })
            .count();
        assert_eq!(first, 1, "{source:?}");
        assert!(projection
            .blocks
            .iter()
            .filter(|block| { block.code && block.range.start.0 > at })
            .all(|block| block.list.as_ref().is_some_and(|list| !list.first)));
    }
}

#[test]
fn terminal_fence_rendering_keeps_the_synthetic_eof_record() {
    for source in [
        "```\ncode\n```\n".to_string(),
        format!("```\n{}```\n", "body\n".repeat(2_000)),
    ] {
        let session = EditorSession::open(&source);
        let end = session.display_text().len();
        let window = range(end, end);
        let projected = session.project(session.revision(), window).unwrap();
        assert!(projected.text.is_empty());
        assert!(projected.blocks.iter().any(|block| block.code));
        assert!(projected
            .blocks
            .iter()
            .any(|block| !block.code && block.range == window));
    }
}
