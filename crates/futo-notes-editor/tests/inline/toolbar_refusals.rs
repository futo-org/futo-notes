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
        ("- a\n  - b\n  - ", 4, 4, true, true),
        ("- a\n  - nested\n- ", 9, 9, true, false),
        ("- a\n\n- ", 3, 3, true, false),
        ("- a\n- \n- b", 2, 2, true, true),
        ("> - a\n> - ", 2, 2, true, true),
        ("- ", 0, 0, false, false),
    ] {
        let mut s = EditorSession::open(source);
        s.select(s.revision(), range(start, end)).unwrap();
        let state = s.toolbar_state();
        assert_eq!(state.can_indent, indent, "{source:?}: Indent");
        assert_eq!(state.can_outdent, outdent, "{source:?}: Outdent");
    }
}
