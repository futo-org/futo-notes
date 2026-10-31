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
