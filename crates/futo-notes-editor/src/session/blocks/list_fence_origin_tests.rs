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
