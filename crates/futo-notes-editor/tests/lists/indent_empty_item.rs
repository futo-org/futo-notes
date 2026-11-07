use super::*;

/// Indent and Tab at the end of `source`, each on a fresh session: the bytes
/// the command writes, with the toolbar's `can_indent` required to agree.
fn indent_at_end(source: &str) -> String {
    let at_end = |source: &str| {
        let mut s = EditorSession::open(source);
        let end = s.display_text().len();
        s.select(s.revision(), range(end, end)).unwrap();
        (s, end)
    };
    let (mut s, end) = at_end(source);
    assert!(s.toolbar_state().can_indent, "{source:?}: can_indent");
    s.block_command(
        s.revision(),
        range(end, end),
        BlockCommand::Indent,
        &mut |_| Ok(()),
    )
    .unwrap_or_else(|error| panic!("{source:?}: Indent refused: {error:?}"))
    .unwrap_or_else(|| panic!("{source:?}: Indent did nothing"));
    let indented = s.source_text();
    s.undo(s.revision(), &mut |_| Ok(())).unwrap();
    assert_eq!(s.source_text(), source, "{source:?}: Undo of Indent");
    let (mut tab, end) = at_end(source);
    tab.paragraph_key(
        tab.revision(),
        range(end, end),
        ParagraphKey::Tab,
        &mut |_| Ok(()),
    )
    .unwrap_or_else(|error| panic!("{source:?}: Tab refused: {error:?}"));
    assert_eq!(tab.source_text(), indented, "{source:?}: Tab");
    indented
}

#[test]
fn an_empty_item_under_a_multi_line_sibling_indents_after_a_separating_blank_line() {
    for (source, indented) in [
        ("- a\n  continuation\n- ", "- a\n  continuation\n\n  - "),
        // A lazy continuation line and a hard break are still the sibling's paragraph.
        ("- a\ncontinuation\n- ", "- a\ncontinuation\n\n  - "),
        ("- a  \n  b\n- ", "- a  \n  b\n\n  - "),
        ("- a\n\n  b\n  c\n- ", "- a\n\n  b\n  c\n\n  - "),
        (
            "- a\n\n  | h | i |\n  | - | - |\n  | 1 | 2 |\n- ",
            "- a\n\n  | h | i |\n  | - | - |\n  | 1 | 2 |\n\n  - ",
        ),
        (
            "- | h | i |\n  | - | - |\n  | 1 | 2 |\n- ",
            "- | h | i |\n  | - | - |\n  | 1 | 2 |\n\n  - ",
        ),
        // Four spaces after an item's content column are a paragraph continuation, not code.
        (
            "- a\n    indented code\n- ",
            "- a\n    indented code\n\n  - ",
        ),
        ("> - a\n>   b\n> - ", "> - a\n>   b\n>\n>   - "),
        ("- a\r\n  b\r\n- ", "- a\r\n  b\r\n\r\n  - "),
        ("1. a\n   b\n2. ", "1. a\n   b\n\n   1. "),
    ] {
        assert_eq!(indent_at_end(source), indented, "{source:?}");
    }
}
