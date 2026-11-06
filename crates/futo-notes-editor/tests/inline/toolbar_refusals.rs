use super::*;

#[test]
fn toolbar_list_eligibility_matches_known_noops_and_empty_item_refusals() {
    for (source, start, end, indent, outdent) in [
        ("plain\n\n- one", 0, 10, false, false),
        ("- a\n- ", 2, 2, false, false),
        ("- a\n  - nested\n- ", 9, 9, true, false),
        ("- a\n\n- ", 3, 3, true, false),
        ("- a\n- \n- b", 2, 2, false, true),
        ("- a\n  - b\n  - ", 4, 4, false, true),
        ("> - a\n> - ", 2, 2, false, true),
        ("- ", 0, 0, false, false),
    ] {
        let mut s = EditorSession::open(source);
        s.select(s.revision(), range(start, end)).unwrap();
        let state = s.toolbar_state();
        assert_eq!(state.can_indent, indent, "{source:?}: Indent");
        assert_eq!(state.can_outdent, outdent, "{source:?}: Outdent");
    }
}
