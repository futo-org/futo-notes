//! Exact staged actions preserve the untouched preceding list owner.
use super::*;

fn exact_stage_case(ending: &str) {
    let full = "- before\n- parent\n  ```lang\n  opaque\n- outside".replace('\n', ending);
    let prefix = "- parent\n  ```lang\n  opaque\n".replace('\n', ending);
    let expected = "\nparent\n```lang\nopaque\n```\n".replace('\n', ending);
    let start = 8 + ending.len();
    let before = "parent\nopaque".replace('\n', ending);
    let after = "\nparent\nopaque".replace('\n', ending);
    for depth in [1, 2] {
        for affinity in [Affinity::Backward, Affinity::Forward] {
            let mut whole = EditorSession::open(&full);
            let mut staged = whole.stage_source(&prefix, start..start + prefix.len());
            for _ in 1..depth {
                staged = staged.stage_source(&prefix, 0..prefix.len());
            }
            assert_eq!(staged.display_text(), before);
            let selected = DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(3),
            };
            let mapped = DisplayRange {
                start: DisplayOffset(ending.len()),
                end: DisplayOffset(ending.len() + 3),
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
            let mut local_view = before.clone();
            local_view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(local_view, after);
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
                start: DisplayOffset(6 + ending.len()),
                end: DisplayOffset(9 + ending.len()),
            };
            let final_selection = DisplayRange {
                start: DisplayOffset(6 + 2 * ending.len()),
                end: DisplayOffset(9 + 2 * ending.len()),
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
            let mut view = "before\nparent\nopaque\noutside".replace('\n', ending);
            view.replace_range(
                final_change.range.start.0..final_change.range.end.0,
                &final_change.inserted,
            );
            assert_eq!(
                whole.source_text(),
                "- before\n\nparent\n```lang\nopaque\n```\n- outside".replace('\n', ending)
            );
            assert_eq!(
                view,
                "before\n\nparent\nopaque\noutside".replace('\n', ending)
            );
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

#[test]
fn exact_stage_promotes_fence_after_inherited_list_prose() {
    exact_stage_case("\n");
}

#[test]
fn exact_stage_crlf_leading_boundary_maps_both_endpoints_and_full_composition() {
    exact_stage_case("\r\n");
}

#[test]
fn newly_inserted_local_opaque_predecessor_overrides_inherited_prose() {
    let full = "- before\n- parent\n  ```lang\n  opaque\n- outside";
    let prefix = "- parent\n  ```lang\n  opaque\n";
    let original = EditorSession::open(full);
    let mut staged = original.stage_source(prefix, 9..9 + prefix.len());
    let zero = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(0),
    };
    staged
        .commit_block_edit(
            Revision(0),
            0..0,
            "- <script>x</script>\n",
            BlockSelection::Display(zero),
            None,
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(
        staged.source_text(),
        "- <script>x</script>\n- parent\n  ```lang\n  opaque\n"
    );
    let selected = DisplayRange {
        start: DisplayOffset(19),
        end: DisplayOffset(22),
    };
    assert_eq!(staged.display_text(), "<script>x</script>\nparent\nopaque");
    let _change = staged
        .block_command(
            staged.revision(),
            selected,
            BlockCommand::Heading(0),
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        staged.source_text(),
        "- <script>x</script>\nparent\n```lang\nopaque\n```\n"
    );
    assert_eq!(staged.selection(), selected);
    staged
        .undo(staged.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(
        staged.source_text(),
        "- <script>x</script>\n- parent\n  ```lang\n  opaque\n"
    );
}
