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

fn mutate_scope(case: &ScopeCase) {
    let old_start = case.before.find("parent").unwrap();
    let new_start = case.shown.find("parent").unwrap();
    let selected = range(old_start, old_start + 3);
    let mapped = range(new_start, new_start + 3);
    for affinity in [Affinity::Backward, Affinity::Forward] {
        let mut s = EditorSession::open(case.source);
        let mut view = ReferenceView::new(case.before);
        s.select_with_affinity(Revision(0), selected, affinity)
            .unwrap();
        let mut refused = 0;
        let rejection = s.block_command(Revision(0), selected, case.command, &mut |_| {
            refused += 1;
            Err("append rejected".into())
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
            .undo(Revision(0), &mut |_| panic!("rejected source made history"))
            .unwrap()
            .is_none());
        let mut accepted = 0;
        let change = s
            .block_command(Revision(0), selected, case.command, &mut |edit| {
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
            .unwrap();
        view.apply(change);
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), case.expected);
        assert_eq!(view.text, case.shown);
        assert_eq!(s.display_text(), case.shown);
        assert_eq!(s.selection(), mapped);
        assert_eq!(s.affinity(), affinity);
        let level = match case.command {
            BlockCommand::Heading(level) => level,
            _ => 0,
        };
        body(&s, "parent", level, None, false, None);
        for &(text, language) in case.codes {
            body(&s, text, 0, None, true, language);
        }
        if case.before.contains("before") {
            body(&s, "before", 0, Some(1), false, None);
        }
        if case.before.contains("outside") {
            body(&s, "outside", 0, Some(1), false, None);
        }
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
fn text_promotes_fence_after_preceding_list_without_reabsorbing_parent_prose() {
    mutate_scope(&PRECEDED);
}

#[test]
fn existing_blank_before_promoted_fence_is_retained_without_duplication() {
    let case = ScopeCase {
        source: "- before\n\n- parent\n  ```lang\n  opaque\n- outside",
        before: "before\n\nparent\nopaque\noutside",
        expected: PRECEDED.expected,
        shown: PRECEDED.shown,
        command: BlockCommand::Heading(0),
        depth: 1,
        codes: PRECEDED.codes,
    };
    literal_scope(&case);
    mutate_scope(&case);
}

#[test]
fn opaque_html_before_promoted_fence_keeps_its_bytes_and_gets_no_new_blank() {
    let case = ScopeCase {
        source: "- <script>x</script>\n- parent\n  ```lang\n  opaque\n- outside",
        before: "<script>x</script>\nparent\nopaque\noutside",
        expected: "- <script>x</script>\nparent\n```lang\nopaque\n```\n- outside",
        shown: "<script>x</script>\nparent\nopaque\noutside",
        command: BlockCommand::Heading(0),
        depth: 1,
        codes: PRECEDED.codes,
    };
    // A source-preservation control, not HTML rendering or interpretation work.
    literal_scope(&case);
    mutate_scope(&case);
}

#[test]
fn empty_list_header_before_promoted_fence_keeps_authored_padding_without_a_blank() {
    let case = ScopeCase {
        source: "-      \n- parent\n  ```lang\n  opaque\n- outside",
        before: "     \nparent\nopaque\noutside",
        expected: "-      \nparent\n```lang\nopaque\n```\n- outside",
        shown: "     \nparent\nopaque\noutside",
        command: BlockCommand::Heading(0),
        depth: 1,
        codes: PRECEDED.codes,
    };
    literal_scope(&case);
    mutate_scope(&case);
}
