use super::*;

// Shipping oracle67 distinguishes Outdent's retained empty paragraph from
// registered Backspace's merge. Literal portable source, not its serializer,
// must carry each empty frame and the remaining canonical owner.
#[test]
fn literal_empty_parent_frames_reopen_with_visible_newlines_and_exact_owners() {
    for (raw, shown, expected) in [
        (
            "- \n  b",
            "\nb",
            vec![(0, Some((1, None, true))), (0, Some((1, None, false)))],
        ),
        (
            "1000. \n      b",
            "\nb",
            vec![
                (0, Some((1, Some(1000), true))),
                (0, Some((1, Some(1000), false))),
            ],
        ),
        (
            "1000.\t\r\n        &acE;\r\n",
            "\r\n\u{223e}\u{0333}\r\n",
            vec![
                (0, Some((1, Some(1000), true))),
                (0, Some((1, Some(1000), false))),
            ],
        ),
        (
            "> - \n>   b",
            "\nb",
            vec![(1, Some((1, None, true))), (1, Some((1, None, false)))],
        ),
        (
            "- \n  - \n    b",
            "\n\nb",
            vec![
                (0, Some((1, None, true))),
                (0, Some((2, None, true))),
                (0, Some((2, None, false))),
            ],
        ),
        (
            "- \n  - b",
            "\nb",
            vec![(0, Some((1, None, true))), (0, Some((2, None, true)))],
        ),
        (
            "- \n  > b",
            "\nb",
            vec![(0, Some((1, None, true))), (1, Some((1, None, false)))],
        ),
        (
            "- \n\n> b",
            "\n\nb",
            vec![(0, Some((1, None, true))), (0, None), (1, None)],
        ),
        ("\n> b", "\nb", vec![(0, None), (1, None)]),
        (
            "- \n  `> b`",
            "\n> b",
            vec![(0, Some((1, None, true))), (0, Some((1, None, false)))],
        ),
    ] {
        let s = EditorSession::open(raw);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.display_text(), shown, "{raw:?}");
        let p = s.project(s.revision(), range(0, shown.len())).unwrap();
        let owners: Vec<_> = p
            .blocks
            .iter()
            .map(|b| {
                (
                    b.quote_depth,
                    b.list.as_ref().map(|l| (l.depth, l.number, l.first)),
                )
            })
            .collect();
        assert_eq!(owners, expected, "{raw:?}");
        assert!(p.blocks.iter().all(|b| !b.code));
        if raw.contains('`') {
            assert!(p
                .runs
                .iter()
                .any(|run| run.formats.contains(&InlineFormat::Code)));
        }
    }
}

#[derive(Clone, Copy)]
enum Action {
    Outdent,
    Backspace,
    Text,
}

fn frame_action(
    raw: &str,
    before: &str,
    expected: &str,
    shown: &str,
    action: Action,
    caret: usize,
    mapped: usize,
) {
    // Prove the literal candidate before attempting any source mutation.
    let reopen = EditorSession::open(expected);
    assert_eq!(reopen.display_text(), shown, "candidate {expected:?}");
    for affinity in [Affinity::Backward, Affinity::Forward] {
        let mut s = EditorSession::open(raw);
        assert_eq!(s.display_text(), before);
        let mut view = ReferenceView::new(before);
        let selected = range(caret, caret);
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
        assert!(matches!(
            apply(&mut s, &mut |_| {
                rejected += 1;
                Err("rejected".into())
            }),
            Err(EditorError::Persistence(_))
        ));
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
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(view.text, before);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), affinity);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(mapped, mapped));
    }
}

macro_rules! frame {
    ($name:ident, $raw:expr, $expected:expr, $shown:expr, $action:ident, $mapped:expr) => {
        #[test]
        fn $name() {
            frame_action($raw, "b", $expected, $shown, Action::$action, 0, $mapped);
        }
    };
}
frame!(
    outdent_retains_empty_list_paragraph,
    "- > b",
    "- \n  b",
    "\nb",
    Outdent,
    1
);
frame!(
    outdent_retains_wide_ordered_parent,
    "1000. > b",
    "1000. \n      b",
    "\nb",
    Outdent,
    1
);
frame!(
    outdent_retains_outer_quote,
    "> - > b",
    "> - \n>   b",
    "\nb",
    Outdent,
    1
);
frame!(
    outdent_retains_both_same_line_list_parents,
    "- - > b",
    "- \n  - \n    b",
    "\n\nb",
    Outdent,
    2
);
frame!(
    backspace_merges_nearest_empty_paragraph,
    "- > b",
    "- b",
    "b",
    Backspace,
    0
);
frame!(
    backspace_keeps_outer_quote,
    "> - > b",
    "> - b",
    "b",
    Backspace,
    0
);
frame!(
    backspace_keeps_outer_empty_list_parent,
    "- - > b",
    "- \n  - b",
    "\nb",
    Backspace,
    1
);
frame!(
    outdent_inner_list_retains_outer_empty_frame,
    "- > - b",
    "- \n  > b",
    "\nb",
    Outdent,
    1
);
frame!(
    backspace_inner_list_retains_outer_empty_frame,
    "- > - b",
    "- \n  > b",
    "\nb",
    Backspace,
    1
);
frame!(
    text_keeps_same_quote_outer_empty_list,
    "- - > b",
    "- \n\n> b",
    "\n\nb",
    Text,
    2
);
frame!(
    text_crosses_quote_with_explicit_empty_frame,
    "- > - b",
    "\n> b",
    "\nb",
    Text,
    1
);

#[test]
fn outdent_retains_tabbed_crlf_frame_and_complete_entity_atom_before_acceptance() {
    frame_action(
        "1000.\t> &acE;\r\n",
        "\u{223e}\u{0333}\r\n",
        "1000.\t\r\n        &acE;\r\n",
        "\r\n\u{223e}\u{0333}\r\n",
        Action::Outdent,
        3,
        5,
    );
}

#[test]
fn outdent_retains_frame_around_opaque_inline_code() {
    frame_action(
        "- > `> b`",
        "> b",
        "- \n  `> b`",
        "\n> b",
        Action::Outdent,
        0,
        1,
    );
}
