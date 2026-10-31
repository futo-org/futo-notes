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
