use super::*;

struct ScopeCase {
    source: &'static str,
    before: &'static str,
    expected: &'static str,
    shown: &'static str,
    command: BlockCommand,
    depth: usize,
    codes: &'static [(&'static str, Option<&'static str>)],
}

const PRECEDED: ScopeCase = ScopeCase {
    source: "- before\n- parent\n  ```lang\n  opaque\n- outside",
    before: "before\nparent\nopaque\noutside",
    expected: "- before\n\nparent\n```lang\nopaque\n```\n- outside",
    shown: "before\n\nparent\nopaque\noutside",
    command: BlockCommand::Heading(0),
    depth: 1,
    codes: &[("opaque", Some("lang"))],
};
const MULTIPLE: ScopeCase = ScopeCase {
    source:
        "- parent\n\n  continuation\n\n  ```one\n  first\n  ```\n\n  ~~~two\n  second\n- outside",
    before: "parent\n\ncontinuation\n\nfirst\n\nsecond\noutside",
    expected: "parent\n\ncontinuation\n\n```one\nfirst\n```\n\n~~~two\nsecond\n~~~\n- outside",
    shown: "parent\n\ncontinuation\n\nfirst\n\nsecond\noutside",
    command: BlockCommand::Heading(0),
    depth: 1,
    codes: &[("first", Some("one")), ("second", Some("two"))],
};
const NESTED_TEXT: ScopeCase = ScopeCase {
    // Exact existing owned-code-authored-blank-spaces fixture result: six
    // authored physical spaces include four container columns and two opaque bytes.
    source: "- before\n  - parent\n    ```\n      \n    ```",
    before: "before\nparent\n  ",
    expected: "- before\n\nparent\n```\n  \n```",
    shown: "before\n\nparent\n  ",
    command: BlockCommand::Heading(0),
    depth: 2,
    codes: &[("  ", None)],
};
const NESTED_HEADING: ScopeCase = ScopeCase {
    source: NESTED_TEXT.source,
    before: NESTED_TEXT.before,
    expected: "- before\n\n## parent\n```\n  \n```",
    shown: NESTED_TEXT.shown,
    command: BlockCommand::Heading(2),
    depth: 2,
    codes: NESTED_TEXT.codes,
};

fn body(
    s: &EditorSession,
    text: &str,
    heading: u8,
    list: Option<usize>,
    code: bool,
    language: Option<&str>,
) {
    let shown = s.display_text();
    let at = shown.find(text).unwrap();
    let p = s.project(s.revision(), range(at, at + text.len())).unwrap();
    assert!(
        p.blocks.iter().any(|b| b.heading == heading
            && b.quote_depth == 0
            && b.list.as_ref().map(|l| l.depth) == list
            && b.code == code
            && b.language.as_deref() == language),
        "{text:?} public body ownership: {:?}",
        p.blocks
    );
}

fn literal_scope(case: &ScopeCase) {
    let initial = EditorSession::open(case.source);
    assert_eq!(initial.source_text(), case.source);
    assert_eq!(initial.display_text(), case.before);
    body(&initial, "parent", 0, Some(case.depth), false, None);
    let target = EditorSession::open(case.expected);
    assert_eq!(target.source_text(), case.expected);
    assert_eq!(target.display_text(), case.shown);
    let level = match case.command {
        BlockCommand::Heading(level) => level,
        _ => 0,
    };
    body(&target, "parent", level, None, false, None);
    for &(text, language) in case.codes {
        body(&initial, text, 0, Some(case.depth), true, language);
        body(&target, text, 0, None, true, language);
    }
    if case.before.contains("before") {
        body(&initial, "before", 0, Some(1), false, None);
        body(&target, "before", 0, Some(1), false, None);
    }
    if case.before.contains("outside") {
        body(&initial, "outside", 0, Some(1), false, None);
        body(&target, "outside", 0, Some(1), false, None);
    }
    if case.before.contains("continuation") {
        body(&initial, "continuation", 0, Some(1), false, None);
        body(&target, "continuation", 0, None, false, None);
    }
}

#[test]
fn preceding_list_requires_the_minimum_blank_for_root_prose_ownership() {
    literal_scope(&PRECEDED);
    let compact = EditorSession::open("- before\nparent\n```lang\nopaque\n```\n- outside");
    assert_eq!(compact.display_text(), "before\nparent\nopaque\noutside");
    body(&compact, "parent", 0, Some(1), false, None);
}
#[test]
fn continuation_and_two_fences_reopen_as_distinct_owned_root_blocks() {
    literal_scope(&MULTIPLE);
}
#[test]
fn existing_nested_authored_code_blank_text_plan_retains_both_opaque_spaces() {
    literal_scope(&NESTED_TEXT);
}
#[test]
fn existing_nested_authored_code_blank_heading_plan_retains_both_opaque_spaces() {
    literal_scope(&NESTED_HEADING);
}
