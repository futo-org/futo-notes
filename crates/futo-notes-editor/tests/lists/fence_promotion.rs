use super::*;

fn prove_fence_plan(
    raw: &str,
    expected: &str,
    shown: &str,
    quotes: usize,
    language: Option<&str>,
    outside_quotes: usize,
) {
    let candidate = EditorSession::open(expected);
    assert_eq!(candidate.source_text(), expected);
    assert_eq!(candidate.display_text(), shown, "literal plan {expected:?}");
    let opening = candidate
        .project(candidate.revision(), range(0, shown.len()))
        .unwrap();
    assert!(opening.blocks.iter().any(|b| b.code));
    assert!(opening
        .blocks
        .iter()
        .filter(|b| b.code)
        .all(|b| b.quote_depth == quotes && b.list.is_none() && b.language.as_deref() == language));
    if let Some(at) = shown.find("outside") {
        let outside = candidate
            .project(candidate.revision(), range(at, at + 7))
            .unwrap();
        assert!(outside.blocks.iter().all(|b| !b.code
            && b.quote_depth == outside_quotes
            && b.list.as_ref().is_some_and(|l| l.first && l.depth() == 1)));
    }
    for affinity in [Affinity::Backward, Affinity::Forward] {
        let mut s = EditorSession::open(raw);
        assert_eq!(s.display_text(), shown);
        let mut view = ReferenceView::new(shown);
        let selected = range(0, 0);
        s.select_with_affinity(s.revision(), selected, affinity)
            .unwrap();
        let mut rejected = 0;
        assert!(matches!(
            s.block_command(
                s.revision(),
                selected,
                BlockCommand::Heading(0),
                &mut |_| {
                    rejected += 1;
                    Err("rejected".into())
                }
            ),
            Err(EditorError::Persistence(_))
        ));
        assert_eq!(rejected, 1);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.revision(), Revision(0));
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), affinity);
        let mut accepted = 0;
        view.apply(
            s.block_command(
                s.revision(),
                selected,
                BlockCommand::Heading(0),
                &mut |_| {
                    accepted += 1;
                    Ok(())
                },
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected, "promoted {raw:?}");
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), selected);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), affinity);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
    }
}

#[test]
fn existing_closers_and_true_eof_remain_exact_during_list_fence_promotion() {
    prove_fence_plan(
        "- parent\n  ```\n  opaque\n  ```\n- outside",
        "parent\n```\nopaque\n```\n- outside",
        "parent\nopaque\noutside",
        0,
        None,
        0,
    );
    prove_fence_plan(
        "- parent\n  ```\n  opaque",
        "parent\n```\nopaque",
        "parent\nopaque",
        0,
        None,
        0,
    );
}

#[test]
fn lifting_an_item_whose_fence_is_unclosed_is_refused_unchanged() {
    // A promoted unclosed fence would run past the item; the generic list path
    // has no fence-closer repair, so the command is refused (DECISIONS #20).
    for raw in [
        "- parent\n  ```\n  opaque\n- outside",
        "- parent\r\n  ~~~~lang\r\n  opaque\r\n- outside",
        "- parent\n  > ```\n  > opaque\n- outside",
        "> - parent\n>   ```\n>   opaque\n> - outside",
        "- parent\r\n   ```Rust\r\n   a\r\n    \r\n   b\r\n- outside",
        "- parent\n  ```\n  a\n  \t\n  b\n- outside",
    ] {
        let mut s = EditorSession::open(raw);
        let selected = range(0, 0);
        s.select(s.revision(), selected).unwrap();
        assert!(matches!(
            s.block_command(
                s.revision(),
                selected,
                BlockCommand::Heading(0),
                &mut |_| panic!("refused before acceptance")
            ),
            Err(EditorError::UnrepresentableFormat)
        ));
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.revision(), Revision(0));
        assert_eq!(s.selection(), selected);
    }
}

#[test]
fn code_enter_after_list_promotion_is_opaque_with_two_exact_undo_groups() {
    let raw = "- parent\n  ```\n  opaque\n  ```\n- outside";
    let promoted = "parent\n```\nopaque\n```\n- outside";
    let expected = "parent\n```\n- opaque\n```\n- outside";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("parent\nopaque\noutside");
    view.apply(
        s.block_command(
            s.revision(),
            range(0, 0),
            BlockCommand::Heading(0),
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), promoted);
    s.select_with_affinity(s.revision(), range(7, 7), Affinity::Backward)
        .unwrap();
    view.apply(
        s.replace(s.revision(), range(7, 7), "- ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), expected);
    let before_enter = range(9, 9);
    s.select_with_affinity(s.revision(), before_enter, Affinity::Backward)
        .unwrap();
    view.apply(
        s.paragraph_key(s.revision(), before_enter, ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "parent\n```\n- \nopaque\n```\n- outside");
    assert_eq!(view.text, "parent\n- \nopaque\noutside");
    let code = s.project(s.revision(), range(7, 16)).unwrap();
    assert!(code.blocks.iter().all(|b| b.code && b.list.is_none()));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
    assert_eq!(s.selection(), before_enter);
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), promoted);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
}
