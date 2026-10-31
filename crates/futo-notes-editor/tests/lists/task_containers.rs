use super::*;

#[test]
fn wide_tabbed_task_retargets_use_content_columns_before_the_checkbox() {
    let raw = "1000.\t[x] parent\n\n        continuation\n\n        ```js\n        opaque\n        ```\n\n        - child\n1001.\toutside";
    let shown = "parent\n\ncontinuation\n\nopaque\n\nchild\noutside";
    for (command, expected, ordinals) in [
        (BlockCommand::OrderedList,
            "1000.\tparent\n\n        continuation\n\n        ```js\n        opaque\n        ```\n\n        - child\n1001.\toutside", vec![Some(1000), None, Some(1001)]),
        (BlockCommand::BulletList,
            "- parent\n\n  continuation\n\n  ```js\n  opaque\n  ```\n\n  - child\n- outside", vec![None, None, None]),
    ] {
        let candidate = EditorSession::open(expected);
        assert_eq!(candidate.display_text(), shown);
        for affinity in [Affinity::Backward, Affinity::Forward] {
            let mut s = EditorSession::open(raw);
            assert_eq!(s.display_text(), shown);
            let mut view = ReferenceView::new(shown);
            let selected = range(0, 0);
            s.select_with_affinity(s.revision(), selected, affinity).unwrap();
            let mut rejected = 0;
            assert!(matches!(s.block_command(s.revision(), selected, command,
                &mut |_| { rejected += 1; Err("rejected".into()) }), Err(EditorError::Persistence(_))));
            assert_eq!(rejected, 1);
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.revision(), Revision(0));
            assert_eq!(s.selection(), selected);
            let mut accepted = 0;
            view.apply(s.block_command(s.revision(), selected, command,
                &mut |_| { accepted += 1; Ok(()) }).unwrap().unwrap());
            assert_eq!(accepted, 1);
            assert_eq!(s.source_text(), expected, "{command:?}");
            assert_eq!(view.text, shown);
            assert_eq!(s.selection(), selected);
            let p = s.project(s.revision(), range(0, shown.len())).unwrap();
            assert!(p.blocks.iter().all(|b| b.list.as_ref().is_none_or(|l| l.checked.is_none())));
            assert!(p.blocks.iter().filter(|b| b.code).all(|b| b.language.as_deref() == Some("js")));
            let items: Vec<_> = p.blocks.iter().filter_map(|b| b.list.as_ref().filter(|l| l.first)).collect();
            assert_eq!(items.iter().map(|l| l.depth).collect::<Vec<_>>(), vec![1, 2, 1]);
            assert_eq!(items.iter().map(|l| l.number).collect::<Vec<_>>(), ordinals);
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
}

const QUOTED_CRLF_TASK: &str = "> 1000.\t[x] parent\r\n>\r\n>       continuation\r\n>\r\n>       ```js\r\n>       opaque\r\n>       ```\r\n>\r\n>       - child\r\n> 1001.\toutside";
const QUOTED_CRLF_SHOWN: &str = "parent\r\n\r\ncontinuation\r\n\r\nopaque\r\n\r\nchild\r\noutside";
const QUOTED_CRLF_ORDERED: &str = "> 1000.\tparent\r\n>\r\n>       continuation\r\n>\r\n>       ```js\r\n>       opaque\r\n>       ```\r\n>\r\n>       - child\r\n> 1001.\toutside";
const QUOTED_CRLF_BULLET: &str = "> - parent\r\n>\r\n>   continuation\r\n>\r\n>   ```js\r\n>   opaque\r\n>   ```\r\n>\r\n>   - child\r\n> - outside";

fn quoted_crlf_open(expected: &str, numbers: &[Option<u64>]) {
    for (raw, expected_numbers, checked) in [
        (
            QUOTED_CRLF_TASK,
            &[Some(1000), None, Some(1001)][..],
            Some(true),
        ),
        (expected, numbers, None),
    ] {
        let s = EditorSession::open(raw);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.display_text(), QUOTED_CRLF_SHOWN);
        let p = s
            .project(s.revision(), range(0, QUOTED_CRLF_SHOWN.len()))
            .unwrap();
        let items: Vec<_> = p
            .blocks
            .iter()
            .filter_map(|b| b.list.as_ref().filter(|l| l.first))
            .collect();
        assert_eq!(
            items.iter().map(|l| l.depth).collect::<Vec<_>>(),
            vec![1, 2, 1]
        );
        assert_eq!(
            items.iter().map(|l| l.number).collect::<Vec<_>>(),
            expected_numbers
        );
        assert_eq!(items[0].checked, checked);
        assert!(p.blocks.iter().all(|b| b.quote_depth == 1));
        assert!(p.blocks.iter().any(|b| b.code
            && b.language.as_deref() == Some("js")
            && b.list.as_ref().is_some_and(|l| l.depth == 1)));
    }
}

#[test]
fn quoted_crlf_tabbed_task_ordered_plan_opens_with_exact_columns_and_fence_owners() {
    quoted_crlf_open(QUOTED_CRLF_ORDERED, &[Some(1000), None, Some(1001)]);
}
#[test]
fn quoted_crlf_tabbed_task_bullet_plan_opens_with_exact_columns_and_fence_owners() {
    quoted_crlf_open(QUOTED_CRLF_BULLET, &[None, None, None]);
}

fn retarget_quoted_crlf_task(command: BlockCommand, expected: &str, numbers: &[Option<u64>]) {
    for affinity in [Affinity::Backward, Affinity::Forward] {
        let mut s = EditorSession::open(QUOTED_CRLF_TASK);
        let mut view = ReferenceView::new(QUOTED_CRLF_SHOWN);
        let selected = range(0, 3);
        s.select_with_affinity(Revision(0), selected, affinity)
            .unwrap();
        let mut refused = 0;
        assert!(matches!(
            s.block_command(Revision(0), selected, command, &mut |_| {
                refused += 1;
                Err("refused".into())
            }),
            Err(EditorError::Persistence(_))
        ));
        assert_eq!(refused, 1);
        assert_eq!(s.source_text(), QUOTED_CRLF_TASK);
        assert_eq!(s.display_text(), QUOTED_CRLF_SHOWN);
        assert_eq!(s.revision(), Revision(0));
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), affinity);
        assert!(s
            .undo(Revision(0), &mut |_| panic!("rejected history"))
            .unwrap()
            .is_none());
        let mut accepted = 0;
        view.apply(
            s.block_command(Revision(0), selected, command, &mut |edit| {
                accepted += 1;
                assert_eq!(edit.previous_revision, Revision(0));
                assert_eq!(edit.revision, Revision(1));
                assert_eq!(
                    edit.removed,
                    QUOTED_CRLF_TASK[edit.range.start.0..edit.range.end.0]
                );
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, QUOTED_CRLF_SHOWN);
        assert_eq!(s.display_text(), QUOTED_CRLF_SHOWN);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), affinity);
        let p = s
            .project(s.revision(), range(0, QUOTED_CRLF_SHOWN.len()))
            .unwrap();
        let items: Vec<_> = p
            .blocks
            .iter()
            .filter_map(|b| b.list.as_ref().filter(|l| l.first))
            .collect();
        assert_eq!(
            items.iter().map(|l| l.depth).collect::<Vec<_>>(),
            vec![1, 2, 1]
        );
        assert_eq!(items.iter().map(|l| l.number).collect::<Vec<_>>(), numbers);
        assert!(items.iter().all(|l| l.checked.is_none()));
        assert!(p.blocks.iter().all(|b| b.quote_depth == 1));
        assert!(p
            .blocks
            .iter()
            .any(|b| b.code && b.language.as_deref() == Some("js")));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), QUOTED_CRLF_TASK);
        assert_eq!(view.text, QUOTED_CRLF_SHOWN);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), affinity);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, QUOTED_CRLF_SHOWN);
    }
}

#[test]
fn quoted_crlf_task_ordered_retarget_preserves_tab_columns_and_nested_fence() {
    retarget_quoted_crlf_task(
        BlockCommand::OrderedList,
        QUOTED_CRLF_ORDERED,
        &[Some(1000), None, Some(1001)],
    );
}
#[test]
fn quoted_crlf_task_bullet_retarget_preserves_continuation_and_nested_fence() {
    retarget_quoted_crlf_task(
        BlockCommand::BulletList,
        QUOTED_CRLF_BULLET,
        &[None, None, None],
    );
}
