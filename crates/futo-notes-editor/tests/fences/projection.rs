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
