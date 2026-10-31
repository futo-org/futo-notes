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
