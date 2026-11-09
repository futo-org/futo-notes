use super::*;

#[test]
fn toolbar_list_eligibility_matches_known_noops() {
    for (source, start, end, indent, outdent) in [
        ("plain\n\n- one", 0, 10, false, false),
        // A new empty item under its sibling's text indents; the last empty root item cannot outdent.
        ("- a\n- ", 2, 2, true, false),
        ("1. a\n2. ", 2, 2, true, false),
        ("- [ ] a\n- [ ] ", 2, 2, true, false),
        ("- a\r\n- ", 3, 3, true, false),
        // The sibling's last block spans several lines: the item still nests.
        ("- a\n  continuation\n- ", 15, 15, true, false),
        ("- a\ncontinuation\n- ", 15, 15, true, false),
        ("- a  \n  b\n- ", 6, 6, true, false),
        ("- a\n\n  b\n  c\n- ", 7, 7, true, false),
        ("- a\n    indented code\n- ", 18, 18, true, false),
        (
            "- | h | i |\n  | - | - |\n  | 1 | 2 |\n- ",
            30,
            30,
            true,
            false,
        ),
        ("> - a\n>   b\n> - ", 4, 4, true, false),
        ("- a\r\n  b\r\n- ", 6, 6, true, false),
        ("- a\n  - b\n  - ", 4, 4, true, true),
        ("- a\n  - nested\n- ", 9, 9, true, false),
        ("- a\n\n- ", 3, 3, true, false),
        ("- a\n- \n- b", 2, 2, true, false),
        ("> - a\n> - ", 2, 2, true, false),
        ("- ", 0, 0, false, false),
    ] {
        let mut s = EditorSession::open(source);
        s.select(s.revision(), range(start, end)).unwrap();
        let state = s.toolbar_state();
        assert_eq!(state.can_indent, indent, "{source:?}: Indent");
        assert_eq!(state.can_outdent, outdent, "{source:?}: Outdent");
    }
}
