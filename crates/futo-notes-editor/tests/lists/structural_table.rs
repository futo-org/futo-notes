use super::*;

struct StructuralCase {
    source: &'static str,
    before: &'static str,
    expected: &'static str,
    shown: &'static str,
    command: BlockCommand,
    heading: u8,
    quote: usize,
    list: Option<usize>,
}
const PLAIN: &str = "- parent\n  - child😀\n    - grandchild\n  - sibling\n- following";
const SAME: &str = "> - parent\n>   - child😀\n>     - grandchild\n>   - sibling\n> - following";
const CROSS: &str = "- parent\n  > - child\n  >   - grandchild\n  > - sibling\n- following";
const UNICODE_SHOWN: &str = "parent\nchild😀\ngrandchild\nsibling\nfollowing";
const UNICODE_SEPARATED: &str = "parent\n\nchild😀\ngrandchild\nsibling\nfollowing";
const CROSS_SHOWN: &str = "parent\nchild\ngrandchild\nsibling\nfollowing";
const CASES: [StructuralCase; 6] = [
    StructuralCase {
        source: PLAIN,
        before: UNICODE_SHOWN,
        expected: "- parent\n\n## child😀\n+ grandchild\n+ sibling\n- following",
        shown: UNICODE_SEPARATED,
        command: BlockCommand::Heading(2),
        heading: 2,
        quote: 0,
        list: None,
    },
    StructuralCase {
        source: PLAIN,
        before: UNICODE_SHOWN,
        expected: "- parent\n\n> child😀\n+ grandchild\n+ sibling\n- following",
        shown: UNICODE_SEPARATED,
        command: BlockCommand::Quote,
        heading: 0,
        quote: 1,
        list: None,
    },
    StructuralCase {
        source: SAME,
        before: UNICODE_SHOWN,
        expected: "> - parent\n>\n> ## child😀\n> + grandchild\n> + sibling\n> - following",
        shown: UNICODE_SEPARATED,
        command: BlockCommand::Heading(2),
        heading: 2,
        quote: 1,
        list: None,
    },
    StructuralCase {
        source: SAME,
        before: UNICODE_SHOWN,
        expected: SAME,
        shown: UNICODE_SHOWN,
        command: BlockCommand::Quote,
        heading: 0,
        quote: 1,
        list: Some(2),
    },
    StructuralCase {
        source: CROSS,
        before: CROSS_SHOWN,
        expected: "parent\n> ## child\n> + grandchild\n> - sibling\n- following",
        shown: CROSS_SHOWN,
        command: BlockCommand::Heading(2),
        heading: 2,
        quote: 1,
        list: None,
    },
    StructuralCase {
        source: CROSS,
        before: CROSS_SHOWN,
        expected: CROSS,
        shown: CROSS_SHOWN,
        command: BlockCommand::Quote,
        heading: 0,
        quote: 1,
        list: Some(2),
    },
];

fn literal(case: &StructuralCase) {
    let original = EditorSession::open(case.source);
    assert_eq!(original.source_text(), case.source);
    assert_eq!(original.display_text(), case.before);
    let target = EditorSession::open(case.expected);
    assert_eq!(target.source_text(), case.expected);
    assert_eq!(target.display_text(), case.shown);
    let start = case.shown.find("child").unwrap();
    let p = target
        .project(Revision(0), range(start, start + 3))
        .unwrap();
    assert!(
        p.blocks.iter().all(|b| !b.code
            && b.heading == case.heading
            && b.quote_depth == case.quote
            && b.list.as_ref().map(|l| l.depth) == case.list),
        "{:?}",
        p.blocks
    );
}

#[test]
fn plain_heading_literal_has_independent_root_and_list_owners() {
    literal(&CASES[0]);
}
#[test]
fn plain_quote_literal_has_independent_quote_and_list_owners() {
    literal(&CASES[1]);
}
#[test]
fn same_quote_heading_literal_preserves_outer_quote_and_earlier_owner() {
    literal(&CASES[2]);
}
#[test]
fn same_quote_noop_literal_preserves_nested_list_owner() {
    literal(&CASES[3]);
}
#[test]
fn cross_quote_heading_literal_promotes_outer_item_and_retains_quote() {
    literal(&CASES[4]);
}
#[test]
fn cross_quote_noop_literal_preserves_original_item_ancestry() {
    literal(&CASES[5]);
}

fn execute(case: &StructuralCase) {
    let at = case.before.find("child").unwrap();
    let next = case.shown.find("child").unwrap();
    let selected = range(at, at + 3);
    let mapped = range(next, next + 3);
    for affinity in [Affinity::Backward, Affinity::Forward] {
        let mut s = EditorSession::open(case.source);
        let mut view = ReferenceView::new(case.before);
        s.select_with_affinity(Revision(0), selected, affinity)
            .unwrap();
        if case.source == case.expected {
            assert!(s
                .block_command(Revision(0), selected, case.command, &mut |_| panic!(
                    "quoted Quote reached host"
                ))
                .unwrap()
                .is_none());
            assert_eq!(s.source_text(), case.source);
            assert_eq!(s.display_text(), case.before);
            assert_eq!(s.revision(), Revision(0));
            assert_eq!(s.selection(), selected);
            assert_eq!(s.affinity(), affinity);
            assert!(s
                .undo(Revision(0), &mut |_| panic!("no-op made history"))
                .unwrap()
                .is_none());
            continue;
        }
        let mut refused = 0;
        let rejection = s.block_command(Revision(0), selected, case.command, &mut |_| {
            refused += 1;
            Err("refused".into())
        });
        assert!(
            matches!(rejection, Err(EditorError::Persistence(_))),
            "{rejection:?}"
        );
        assert_eq!(refused, 1);
        assert_eq!(s.source_text(), case.source);
        assert_eq!(s.display_text(), case.before);
        assert_eq!(s.revision(), Revision(0));
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), affinity);
        assert!(s
            .undo(Revision(0), &mut |_| panic!("rejected history"))
            .unwrap()
            .is_none());
        let mut accepted = 0;
        view.apply(
            s.block_command(Revision(0), selected, case.command, &mut |edit| {
                accepted += 1;
                assert_eq!(edit.previous_revision, Revision(0));
                assert_eq!(edit.revision, Revision(1));
                assert_eq!(
                    edit.removed,
                    case.source[edit.range.start.0..edit.range.end.0]
                );
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), case.expected);
        assert_eq!(s.display_text(), case.shown);
        assert_eq!(view.text, case.shown);
        assert_eq!(s.selection(), mapped);
        assert_eq!(s.affinity(), affinity);
        let p = s.project(s.revision(), mapped).unwrap();
        assert!(p.blocks.iter().all(|b| !b.code
            && b.heading == case.heading
            && b.quote_depth == case.quote
            && b.list.as_ref().map(|l| l.depth) == case.list));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), case.source);
        assert_eq!(view.text, case.before);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), affinity);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), case.expected);
        assert_eq!(view.text, case.shown);
        assert_eq!(s.selection(), mapped);
    }
}

#[test]
fn final_plain_nested_heading_preserves_owners_source_selection_and_history() {
    execute(&CASES[0]);
}
#[test]
fn final_plain_nested_quote_preserves_owners_source_selection_and_history() {
    execute(&CASES[1]);
}
#[test]
fn final_same_quote_nested_heading_preserves_owners_source_selection_and_history() {
    execute(&CASES[2]);
}
#[test]
fn final_same_quote_quote_declines_without_source_host_or_history() {
    execute(&CASES[3]);
}
#[test]
fn final_cross_quote_heading_preserves_owners_source_selection_and_history() {
    execute(&CASES[4]);
}
#[test]
fn final_cross_quote_quote_declines_without_source_host_or_history() {
    execute(&CASES[5]);
}

#[test]
fn an_extra_after_quote_marker_creates_an_empty_list_item_not_a_retained_parent() {
    let compact = EditorSession::open(CASES[1].expected);
    let extra =
        EditorSession::open("- parent\n\n> child😀\n+\n+ grandchild\n+ sibling\n- following");
    let empties = |s: &EditorSession| {
        let shown = s.display_text();
        let p = s.project(s.revision(), range(0, shown.len())).unwrap();
        p.blocks
            .iter()
            .filter(|b| {
                b.list.as_ref().is_some_and(|l| l.first)
                    && shown[b.range.start.0..b.range.end.0]
                        .trim_end_matches(['\r', '\n'])
                        .is_empty()
            })
            .count()
    };
    assert_eq!(empties(&compact), 0);
    assert_eq!(empties(&extra), 1);
    assert_ne!(compact.display_text(), extra.display_text());
}

#[test]
fn quoting_the_already_lifted_child_must_not_insert_a_new_empty_list_item() {
    execute(&StructuralCase {
        source: "- parent\n\nchild😀\n+ grandchild\n+ sibling\n- following",
        before: UNICODE_SEPARATED,
        expected: CASES[1].expected,
        shown: UNICODE_SEPARATED,
        command: BlockCommand::Quote,
        heading: 0,
        quote: 1,
        list: None,
    });
}
