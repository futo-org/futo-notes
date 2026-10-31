use super::*;

fn prove_fence_plan(raw: &str, expected: &str, shown: &str, quotes: usize, language: Option<&str>) {
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
            && b.quote_depth == 0
            && b.list.as_ref().is_some_and(|l| l.first && l.depth == 1)));
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
fn lifting_a_list_item_closes_its_unmatched_fence_before_the_untouched_outside_item() {
    prove_fence_plan(
        "- parent\n  ```\n  opaque\n- outside",
        "parent\n```\nopaque\n```\n- outside",
        "parent\nopaque\noutside",
        0,
        None,
    );
}

#[test]
fn promoted_unmatched_fences_retain_raw_tilde_width_info_and_crlf() {
    prove_fence_plan(
        "- parent\r\n  ~~~~lang\r\n  opaque\r\n- outside",
        "parent\r\n~~~~lang\r\nopaque\r\n~~~~\r\n- outside",
        "parent\r\nopaque\r\noutside",
        0,
        Some("lang"),
    );
}

#[test]
fn a_retained_quote_boundary_still_closes_its_promoted_unmatched_fence() {
    prove_fence_plan(
        "- parent\n  > ```\n  > opaque\n- outside",
        "parent\n> ```\n> opaque\n- outside",
        "parent\nopaque\noutside",
        1,
        None,
    );
}

#[test]
fn existing_closers_and_true_eof_remain_exact_during_list_fence_promotion() {
    prove_fence_plan(
        "- parent\n  ```\n  opaque\n  ```\n- outside",
        "parent\n```\nopaque\n```\n- outside",
        "parent\nopaque\noutside",
        0,
        None,
    );
    prove_fence_plan(
        "- parent\n  ```\n  opaque",
        "parent\n```\nopaque",
        "parent\nopaque",
        0,
        None,
    );
}
