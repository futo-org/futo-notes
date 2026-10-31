use super::*;

// The ten shipping oracle101 observations share these six original sources.
// Outdent retains a parallel empty paragraph, Backspace merges it, and full
// Text retires all list ancestry. Serializer blank normalization is not gold.
#[test]
fn literal_multiline_frame_plans_reopen_with_their_public_body_owners() {
    for (raw, shown, depth, quotes, number) in [
        ("- > b\n  > c", "b\nc", Some(1), 1, None),
        ("- > b\n  c", "b\nc", Some(1), 1, None),
        ("> - > b\n>   > c", "b\nc", Some(1), 2, None),
        ("1000.\t> b\n        > c", "b\nc", Some(1), 1, Some(1000)),
        ("- - > b\n    > c", "b\nc", Some(2), 1, None),
        ("- > - b\n  >   c", "b\nc", Some(2), 1, None),
        ("- \n  b\n  c", "\nb\nc", Some(1), 0, None),
        ("> - \n>   b\n>   c", "\nb\nc", Some(1), 1, None),
        (
            "1000.\t\n        b\n        c",
            "\nb\nc",
            Some(1),
            0,
            Some(1000),
        ),
        ("- b\n  c", "b\nc", Some(1), 0, None),
        ("> - b\n>   c", "b\nc", Some(1), 1, None),
        ("\n> b\n> c", "\nb\nc", None, 1, None),
        ("- \n\n> b\n> c", "\n\nb\nc", None, 1, None),
    ] {
        let s = EditorSession::open(raw);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.display_text(), shown, "{raw:?}");
        for body in ['b', 'c'] {
            let at = shown.find(body).unwrap();
            let projected = s.project(s.revision(), range(at, at + 1)).unwrap();
            assert!(
                projected.blocks.iter().any(|block| !block.code
                    && block.heading == 0
                    && block.quote_depth == quotes
                    && block.list.as_ref().map(|list| (list.depth, list.number))
                        == depth.map(|depth| (depth, number))),
                "{raw:?} at {body}"
            );
        }
    }
}

#[derive(Clone, Copy)]
enum Action {
    Outdent,
    Backspace,
    Text,
}

fn multiline_action(raw: &str, expected: &str, shown: &str, action: Action, mapped: usize) {
    multiline_transition(
        raw,
        "b\nc",
        expected,
        shown,
        action,
        range(0, 0),
        range(mapped, mapped),
    );
}

fn multiline_transition(
    raw: &str,
    before: &str,
    expected: &str,
    shown: &str,
    action: Action,
    selected: DisplayRange,
    mapped: DisplayRange,
) {
    for affinity in [Affinity::Backward, Affinity::Forward] {
        let mut s = EditorSession::open(raw);
        assert_eq!(s.display_text(), before);
        let mut view = ReferenceView::new(before);
        s.select_with_affinity(s.revision(), selected, affinity)
            .unwrap();
        let apply =
            |s: &mut EditorSession, accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>| {
                match action {
                    Action::Outdent => {
                        s.block_command(s.revision(), selected, BlockCommand::Outdent, accept)
                    }
                    Action::Text => {
                        s.block_command(s.revision(), selected, BlockCommand::Heading(0), accept)
                    }
                    Action::Backspace => {
                        s.paragraph_key(s.revision(), selected, ParagraphKey::Backspace, accept)
                    }
                }
            };
        let mut rejected = 0;
        let refusal = apply(&mut s, &mut |_| {
            rejected += 1;
            Err("rejected".into())
        });
        assert!(
            matches!(refusal, Err(EditorError::Persistence(_))),
            "{raw:?}: {refusal:?}"
        );
        assert_eq!(rejected, 1);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.revision(), Revision(0));
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), affinity);
        let mut accepted = 0;
        view.apply(
            apply(&mut s, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), mapped);
        assert_eq!(s.affinity(), affinity);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(view.text, before);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), affinity);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), mapped);
    }
}

macro_rules! multiline {
    ($name:ident, $raw:expr, $expected:expr, $shown:expr, $action:ident, $mapped:expr) => {
        #[test]
        fn $name() {
            multiline_action($raw, $expected, $shown, Action::$action, $mapped);
        }
    };
}

multiline!(
    outdent_explicit_quote_body,
    "- > b\n  > c",
    "- \n  b\n  c",
    "\nb\nc",
    Outdent,
    1
);

multiline!(
    outdent_lazy_quote_body,
    "- > b\n  c",
    "- \n  b\n  c",
    "\nb\nc",
    Outdent,
    1
);

multiline!(
    outdent_retains_outer_quote_body,
    "> - > b\n>   > c",
    "> - \n>   b\n>   c",
    "\nb\nc",
    Outdent,
    1
);

multiline!(
    outdent_wide_tabbed_quote_body,
    "1000.\t> b\n        > c",
    "1000.\t\n        b\n        c",
    "\nb\nc",
    Outdent,
    1
);

multiline!(
    backspace_merges_explicit_quote_body,
    "- > b\n  > c",
    "- b\n  c",
    "b\nc",
    Backspace,
    0
);

multiline!(
    backspace_merges_lazy_quote_body,
    "- > b\n  c",
    "- b\n  c",
    "b\nc",
    Backspace,
    0
);

multiline!(
    backspace_merges_inner_quote_body,
    "> - > b\n>   > c",
    "> - b\n>   c",
    "b\nc",
    Backspace,
    0
);

multiline!(
    text_lifts_root_quote_body,
    "- > b\n  > c",
    "\n> b\n> c",
    "\nb\nc",
    Text,
    1
);

multiline!(
    text_lifts_shared_nested_quote_body,
    "- - > b\n    > c",
    "- \n\n> b\n> c",
    "\n\nb\nc",
    Text,
    2
);

multiline!(
    text_lifts_crossquote_inner_body,
    "- > - b\n  >   c",
    "\n> b\n> c",
    "\nb\nc",
    Text,
    1
);

#[test]
fn literal_crlf_entity_frames_preserve_both_body_owners_and_raw_atoms() {
    for (raw, shown, depth, quotes, first) in [
        (
            "> - > &acE;\r\n>   > c",
            "\u{223e}\u{0333}\r\nc",
            Some(1),
            2,
            true,
        ),
        (
            "> - \r\n>   &acE;\r\n>   c",
            "\r\n\u{223e}\u{0333}\r\nc",
            Some(1),
            1,
            false,
        ),
        (
            "> - &acE;\r\n>   c",
            "\u{223e}\u{0333}\r\nc",
            Some(1),
            1,
            true,
        ),
        (
            "- > - &acE;\r\n  >   c",
            "\u{223e}\u{0333}\r\nc",
            Some(2),
            1,
            true,
        ),
        (
            "\r\n> &acE;\r\n> c",
            "\r\n\u{223e}\u{0333}\r\nc",
            None,
            1,
            false,
        ),
    ] {
        let s = EditorSession::open(raw);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.display_text(), shown, "{raw:?}");
        let body = shown.find('\u{223e}').unwrap();
        let p = s.project(s.revision(), range(body, body + 5)).unwrap();
        assert!(
            p.blocks.iter().any(|b| !b.code
                && b.heading == 0
                && b.quote_depth == quotes
                && b.list.as_ref().map(|l| (l.depth, l.first)) == depth.map(|d| (d, first))),
            "{raw:?}"
        );
        let c = shown.find('c').unwrap();
        let p = s.project(s.revision(), range(c, c + 1)).unwrap();
        assert!(
            p.blocks.iter().any(|b| !b.code
                && b.heading == 0
                && b.quote_depth == quotes
                && b.list.as_ref().map(|l| l.depth) == depth),
            "{raw:?}"
        );
        assert!(raw.contains("&acE;"));
    }
}

fn crlf_atom_transition(raw: &str, expected: &str, shown: &str, action: Action, added: usize) {
    multiline_transition(
        raw,
        "\u{223e}\u{0333}\r\nc",
        expected,
        shown,
        action,
        range(0, 3),
        range(added, added + 3),
    );
}

#[test]
fn outdent_crlf_outer_quote_maps_both_entity_endpoints_before_acceptance() {
    crlf_atom_transition(
        "> - > &acE;\r\n>   > c",
        "> - \r\n>   &acE;\r\n>   c",
        "\r\n\u{223e}\u{0333}\r\nc",
        Action::Outdent,
        2,
    );
}

#[test]
fn backspace_crlf_outer_quote_retains_the_complete_entity_at_its_start_caret() {
    // Backspace requires a caret at its registered paragraph start. Probe its
    // complete atom's strict interior separately through toolbar Outdent/Text.
    multiline_transition(
        "> - > &acE;\r\n>   > c",
        "\u{223e}\u{0333}\r\nc",
        "> - &acE;\r\n>   c",
        "\u{223e}\u{0333}\r\nc",
        Action::Backspace,
        range(0, 0),
        range(0, 0),
    );
}

#[test]
fn text_crlf_crossquote_maps_both_entity_endpoints_before_acceptance() {
    crlf_atom_transition(
        "- > - &acE;\r\n  >   c",
        "\r\n> &acE;\r\n> c",
        "\r\n\u{223e}\u{0333}\r\nc",
        Action::Text,
        2,
    );
}

#[test]
fn outdent_paragraph_keeps_later_mixed_ending_quote_fence_and_foreign_item_exact() {
    let tail = "  >\r\n  > tail\r\n  > ```lang\r\n  > opaque\r\n  > ```\r\n- outside";
    let raw = format!("- > &acE;\n  > c\n{tail}");
    let expected = format!("- \n  &acE;\n  c\n{tail}");
    let before = "\u{223e}\u{0333}\nc\n\r\ntail\r\nopaque\r\noutside";
    let shown = format!("\n{before}");
    let reopened = EditorSession::open(&expected);
    assert_eq!(reopened.source_text(), expected);
    assert_eq!(reopened.display_text(), shown);
    let code_at = shown.find("opaque").unwrap();
    let code = reopened
        .project(reopened.revision(), range(code_at, code_at + 6))
        .unwrap();
    assert!(code.blocks.iter().any(|b| b.code
        && b.quote_depth == 1
        && b.language.as_deref() == Some("lang")
        && b.list.as_ref().is_some_and(|l| l.depth == 1)));
    let outside_at = shown.find("outside").unwrap();
    let outside = reopened
        .project(reopened.revision(), range(outside_at, shown.len()))
        .unwrap();
    assert!(outside.blocks.iter().all(|b| !b.code
        && b.quote_depth == 0
        && b.list.as_ref().is_some_and(|l| l.depth == 1 && l.first)));
    multiline_transition(
        &raw,
        before,
        &expected,
        &shown,
        Action::Outdent,
        range(0, 3),
        range(1, 4),
    );
}
