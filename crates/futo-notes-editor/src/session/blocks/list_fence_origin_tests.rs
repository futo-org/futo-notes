//! Public actions in real staging contexts must not invent physical EOF.
use super::*;

#[test]
fn exact_nested_stages_distinguish_foreign_source_from_genuine_document_eof() {
    let prefix = "- parent\n  ```\n  opaque\n";
    for foreign in ["", "- outside", "<!-- -->\n"] {
        for depth in [1, 2] {
            let mut staged = EditorSession::open(&format!("{prefix}{foreign}"));
            for _ in 0..depth {
                staged = staged.stage_source(prefix, 0..prefix.len());
            }
            let before = staged.source_text();
            let selected = DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(0),
            };
            staged
                .select_with_affinity(staged.revision(), selected, Affinity::Backward)
                .unwrap();
            let mut accepted = 0;
            let change = staged
                .block_command(
                    staged.revision(),
                    selected,
                    BlockCommand::Heading(0),
                    &mut |_| {
                        accepted += 1;
                        Ok(())
                    },
                )
                .unwrap()
                .unwrap();
            assert_eq!(accepted, 1);
            let expected = if foreign.is_empty() {
                "parent\n```\nopaque\n"
            } else {
                "parent\n```\nopaque\n```\n"
            };
            assert_eq!(
                staged.source_text(),
                expected,
                "foreign{foreign:?}, exactdepth{depth}"
            );
            let mut display = "parent\nopaque".to_owned();
            display.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(display, "parent\nopaque");
            staged
                .undo(staged.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(staged.source_text(), before);
            assert_eq!(staged.affinity(), Affinity::Backward);
            staged
                .redo(staged.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(staged.source_text(), expected);
        }
    }
}

#[test]
fn an_exact_grandchild_of_derived_body_cannot_claim_eof_after_hidden_tail_is_omitted() {
    let prefix = "- parent\n  ```\n  opaque\n";
    let full = format!("{prefix}<!-- -->\n");
    let original = EditorSession::open(&full);
    // The body transform intentionally omits a hidden physical tail inside its
    // source envelope. Its semantic after-context is genuine EOF; raw byte
    // lengths in an exact grandchild cannot restore physical correspondence.
    let derived = original.stage_body_source(prefix, 0..full.len());
    let mut staged = derived.stage_source(prefix, 0..prefix.len());
    let selected = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(0),
    };
    staged
        .select_with_affinity(staged.revision(), selected, Affinity::Backward)
        .unwrap();
    let mut accepted = 0;
    let result = staged.block_command(
        staged.revision(),
        selected,
        BlockCommand::Heading(0),
        &mut |_| {
            accepted += 1;
            Ok(())
        },
    );
    assert!(matches!(result, Err(EditorError::UnrepresentableFormat)));
    assert_eq!(accepted, 0);
    assert_eq!(staged.source_text(), prefix);
    assert_eq!(staged.revision(), Revision(0));
    assert_eq!(staged.selection(), selected);
    assert_eq!(staged.affinity(), Affinity::Backward);
    assert_eq!(original.source_text(), full);
}

#[test]
fn a_derived_local_foreign_tail_cannot_recertify_original_fence_termination() {
    let raw = "- parent\n  ```\n  opaque\n- outside";
    let original = EditorSession::open(raw);
    let derived = original.stage_body_source(raw, 0..raw.len());
    for exact_grandchild in [false, true] {
        let mut staged = if exact_grandchild {
            derived.stage_source(raw, 0..raw.len())
        } else {
            original.stage_body_source(raw, 0..raw.len())
        };
        let selected = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(0),
        };
        staged
            .select_with_affinity(staged.revision(), selected, Affinity::Backward)
            .unwrap();
        let mut accepted = 0;
        let result = staged.block_command(
            staged.revision(),
            selected,
            BlockCommand::Heading(0),
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        );
        assert!(
            matches!(result, Err(EditorError::UnrepresentableFormat)),
            "exactGrandchild{exact_grandchild}"
        );
        assert_eq!(accepted, 0);
        assert_eq!(staged.source_text(), raw);
        assert_eq!(staged.display_text(), "parent\nopaque\noutside");
        assert_eq!(staged.revision(), Revision(0));
        assert_eq!(staged.selection(), selected);
        assert_eq!(staged.affinity(), Affinity::Backward);
    }
    assert_eq!(original.source_text(), raw);
}

#[test]
fn exact_local_interior_and_ongoing_code_windows_reject_without_acceptance() {
    let root = "- parent\n  ```\n  opaque\n- outside";
    let full = format!("before\n\n{root}\n\n<!-- -->\n");
    let original = EditorSession::open(&full);
    let interior = original.stage_source(root, 8..8 + root.len());
    let ongoing = "- parent\n  ```\n  opaque\n";
    let original_code = EditorSession::open(&format!("{ongoing}  still code\n- outside"));
    let inside_code = original_code.stage_source(ongoing, 0..ongoing.len());
    for mut staged in [interior, inside_code] {
        let raw = staged.source_text();
        let shown = staged.display_text();
        let selected = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(0),
        };
        staged
            .select_with_affinity(staged.revision(), selected, Affinity::Forward)
            .unwrap();
        let mut accepts = 0;
        assert!(matches!(
            staged.block_command(
                staged.revision(),
                selected,
                BlockCommand::Heading(0),
                &mut |_| {
                    accepts += 1;
                    Ok(())
                }
            ),
            Err(EditorError::UnrepresentableFormat)
        ));
        assert_eq!(accepts, 0);
        assert_eq!(staged.source_text(), raw);
        assert_eq!(staged.display_text(), shown);
        assert_eq!(staged.selection(), selected);
        assert_eq!(staged.affinity(), Affinity::Forward);
        assert_eq!(staged.revision(), Revision(0));
        assert!(staged
            .undo(staged.revision(), &mut |_| Ok(()))
            .unwrap()
            .is_none());
    }
}

fn exact_quote_owner_boundary_case(ending: &str, existing_gap: bool) {
    let code_prefix = "- parent\n  > ```\n  > opaque\n".replace('\n', ending);
    let prefix = format!("{code_prefix}{}", if existing_gap { ending } else { "" });
    let outside = "> - outside";
    let full = format!("{prefix}{outside}");
    let expected_prefix = "parent\n> ```\n> opaque\n\n".replace('\n', ending);
    let local_before = if existing_gap {
        "parent\nopaque\n\n"
    } else {
        "parent\nopaque"
    }
    .replace('\n', ending);
    let local_after = "parent\nopaque\n\n".replace('\n', ending);
    let full_before = format!(
        "parent{ending}opaque{ending}{}outside",
        if existing_gap { ending } else { "" }
    );
    let full_after = format!("{local_after}outside");
    for depth in [1, 2] {
        for affinity in [Affinity::Backward, Affinity::Forward] {
            let mut whole = EditorSession::open(&full);
            let mut staged = whole.stage_source(&prefix, 0..prefix.len());
            for _ in 1..depth {
                staged = staged.stage_source(&prefix, 0..prefix.len());
            }
            assert_eq!(staged.display_text(), local_before);
            let selected = DisplayRange {
                start: DisplayOffset(3),
                end: DisplayOffset(3),
            };
            staged
                .select_with_affinity(staged.revision(), selected, affinity)
                .unwrap();
            let mut refused = 0;
            assert!(matches!(
                staged.block_command(
                    staged.revision(),
                    selected,
                    BlockCommand::Heading(0),
                    &mut |_| {
                        refused += 1;
                        Err("refused".into())
                    }
                ),
                Err(EditorError::Persistence(_))
            ));
            assert_eq!(refused, 1);
            assert_eq!(staged.source_text(), prefix);
            assert_eq!(staged.display_text(), local_before);
            assert_eq!(staged.selection(), selected);
            assert_eq!(staged.affinity(), affinity);
            let mut protected = None;
            let change = staged
                .block_command(
                    staged.revision(),
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
            let mut local_view = local_before.clone();
            local_view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(staged.source_text(), expected_prefix);
            assert_eq!(local_view, local_after);
            assert_eq!(staged.selection(), selected);
            staged
                .undo(staged.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(staged.source_text(), prefix);
            assert_eq!(staged.selection(), selected);
            assert_eq!(staged.affinity(), affinity);
            staged
                .redo(staged.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(staged.source_text(), expected_prefix);
            // Compose the exact staged source edit through the real owner's
            // protected commit, as an outer transaction does. No foreign bytes
            // are copied into the child and no native/Store execution is claimed.
            whole
                .select_with_affinity(whole.revision(), selected, affinity)
                .unwrap();
            let mut accepts = 0;
            let final_change = whole
                .commit_block_edit(
                    whole.revision(),
                    edit.range.start.0..edit.range.end.0,
                    &edit.inserted,
                    BlockSelection::Display(selected),
                    None,
                    &mut |_| {
                        accepts += 1;
                        Ok(())
                    },
                )
                .unwrap();
            let mut full_view = full_before.clone();
            full_view.replace_range(
                final_change.range.start.0..final_change.range.end.0,
                &final_change.inserted,
            );
            assert_eq!(accepts, 1);
            assert_eq!(whole.source_text(), format!("{expected_prefix}{outside}"));
            assert_eq!(full_view, full_after);
            let foreign_at = whole.source_text().rfind(outside).unwrap();
            let (foreign, base) = whole.projection.block_ref_at_source(foreign_at).unwrap();
            assert_eq!(base + foreign.source.start, foreign_at);
            assert!(foreign.quote_start && !foreign.code && foreign.quote_depth == 1);
            assert!(foreign
                .list
                .as_ref()
                .is_some_and(|l| l.first && l.depth == 1));
            whole
                .undo(whole.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(whole.source_text(), full);
            assert_eq!(whole.display_text(), full_before);
            assert_eq!(whole.selection(), selected);
            assert_eq!(whole.affinity(), affinity);
            whole
                .redo(whole.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(whole.source_text(), format!("{expected_prefix}{outside}"));
            assert_eq!(whole.display_text(), full_after);
        }
    }
}

#[test]
fn exact_quote_boundary_at_foreign_edge_has_correct_local_and_complete_lf_delta() {
    exact_quote_owner_boundary_case("\n", false);
}
#[test]
fn exact_quote_boundary_at_foreign_edge_has_correct_local_and_complete_crlf_delta() {
    exact_quote_owner_boundary_case("\r\n", false);
}
#[test]
fn exact_quote_boundary_at_foreign_edge_keeps_existing_lf_gap() {
    exact_quote_owner_boundary_case("\n", true);
}
#[test]
fn exact_quote_boundary_at_foreign_edge_keeps_existing_crlf_gap() {
    exact_quote_owner_boundary_case("\r\n", true);
}
