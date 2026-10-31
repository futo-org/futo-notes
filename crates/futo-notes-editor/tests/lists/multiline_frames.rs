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
    for affinity in [Affinity::Backward, Affinity::Forward] {
        let mut s = EditorSession::open(raw);
        assert_eq!(s.display_text(), "b\nc");
        let mut view = ReferenceView::new("b\nc");
        let selected = range(0, 0);
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
        assert_eq!(s.selection(), range(mapped, mapped));
        assert_eq!(s.affinity(), affinity);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(view.text, "b\nc");
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), affinity);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(mapped, mapped));
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
