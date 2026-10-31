//! Exact staged actions preserve the untouched preceding list owner.
use super::*;

#[test]
fn exact_stage_promotes_fence_after_inherited_list_prose() {
    let full = "- before\n- parent\n  ```lang\n  opaque\n- outside";
    let prefix = "- parent\n  ```lang\n  opaque\n";
    let expected = "\nparent\n```lang\nopaque\n```\n";
    let start = "- before\n".len();
    for depth in [1, 2] {
        for affinity in [Affinity::Backward, Affinity::Forward] {
            let mut whole = EditorSession::open(full);
            let mut staged = whole.stage_source(prefix, start..start + prefix.len());
            for _ in 1..depth {
                staged = staged.stage_source(prefix, 0..prefix.len());
            }
            assert_eq!(staged.display_text(), "parent\nopaque");
            let selected = DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(3),
            };
            let mapped = DisplayRange {
                start: DisplayOffset(1),
                end: DisplayOffset(4),
            };
            staged
                .select_with_affinity(Revision(0), selected, affinity)
                .unwrap();
            let mut refused = 0;
            let rejection =
                staged.block_command(Revision(0), selected, BlockCommand::Heading(0), &mut |_| {
                    refused += 1;
                    Err("refused".into())
                });
            assert!(
                matches!(rejection, Err(EditorError::Persistence(_))),
                "{rejection:?}"
            );
            assert_eq!(refused, 1);
            assert_eq!(staged.source_text(), prefix);
            assert_eq!(staged.selection(), selected);
            assert_eq!(staged.affinity(), affinity);
            assert_eq!(staged.revision(), Revision(0));
            assert!(staged
                .undo(Revision(0), &mut |_| panic!("rejected history"))
                .unwrap()
                .is_none());
            let mut protected = None;
            let change = staged
                .block_command(
                    Revision(0),
                    selected,
                    BlockCommand::Heading(0),
                    &mut |edit| {
                        assert!(protected.is_none());
                        protected = Some(edit.clone());
                        Ok(())
                    },
                )
                .unwrap()
                .unwrap();
            let edit = protected.unwrap();
            assert_eq!(edit.previous_revision, Revision(0));
            assert_eq!(edit.revision, Revision(1));
            assert_eq!(edit.removed, prefix[edit.range.start.0..edit.range.end.0]);
            assert_eq!(
                edit.removed,
                full[start + edit.range.start.0..start + edit.range.end.0]
            );
            let mut local_view = "parent\nopaque".to_owned();
            local_view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(local_view, "\nparent\nopaque");
            assert_eq!(staged.source_text(), expected);
            assert_eq!(staged.selection(), mapped);
            staged
                .undo(staged.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(staged.source_text(), prefix);
            assert_eq!(staged.selection(), selected);
            staged
                .redo(staged.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(staged.source_text(), expected);
            // Synthetic outer transaction using the actual staged callback edit.
            // This is not Store or native execution.
            let old_selection = DisplayRange {
                start: DisplayOffset(7),
                end: DisplayOffset(10),
            };
            let final_selection = DisplayRange {
                start: DisplayOffset(8),
                end: DisplayOffset(11),
            };
            whole
                .select_with_affinity(Revision(0), old_selection, affinity)
                .unwrap();
            let final_change = whole
                .commit_block_edit(
                    Revision(0),
                    start + edit.range.start.0..start + edit.range.end.0,
                    &edit.inserted,
                    BlockSelection::Display(final_selection),
                    None,
                    &mut |_| Ok(()),
                )
                .unwrap();
            let mut view = "before\nparent\nopaque\noutside".to_owned();
            view.replace_range(
                final_change.range.start.0..final_change.range.end.0,
                &final_change.inserted,
            );
            assert_eq!(
                whole.source_text(),
                "- before\n\nparent\n```lang\nopaque\n```\n- outside"
            );
            assert_eq!(view, "before\n\nparent\nopaque\noutside");
            assert_eq!(whole.display_text(), view);
            assert_eq!(whole.selection(), final_selection);
            let p = whole.project(whole.revision(), final_selection).unwrap();
            assert!(p
                .blocks
                .iter()
                .all(|b| !b.code && b.list.is_none() && b.quote_depth == 0));
            whole
                .undo(whole.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(whole.source_text(), full);
            assert_eq!(whole.selection(), old_selection);
            assert_eq!(whole.affinity(), affinity);
            whole
                .redo(whole.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(whole.display_text(), view);
        }
    }
}
