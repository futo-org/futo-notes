use super::{assert_windows_match_the_whole, plan, windowed};
use futo_notes_editor::host::{DisplayMirror, StyleSpec};
use futo_notes_editor::{CodeLineMark, EditorSession};

/// Every code block a window plans is the whole note's, unchanged, and a window holding a code
/// line also holds its block.
pub fn assert_blocks_stay_whole(spans: &[StyleSpec], whole: &[StyleSpec]) {
    let blocks: Vec<&StyleSpec> = spans
        .iter()
        .filter(|span| matches!(span, StyleSpec::CodeBlock { .. }))
        .collect();
    for block in &blocks {
        assert!(whole.contains(block), "{block:?} is not the whole note's");
    }
    for span in spans {
        if let StyleSpec::Code { start, end, .. } = span {
            let held = blocks.iter().any(|block| {
                let (block_start, block_end) = block.range();
                block_start <= *start && *start <= block_end.max(*end)
            });
            assert!(held, "{span:?} has no block in {spans:?}");
        }
    }
}

#[test]
fn every_window_of_adjacent_and_marked_blocks_matches_the_whole_plan() {
    assert_windows_match_the_whole(
        "```js hl:2\na\nb\n```\n```js\nc\n```\n```\n```\n- x\n  ```\n  😀\n\n  ```\n```py\nopen",
    );
}

#[test]
fn a_block_plans_once_with_its_facts_and_each_line_with_its_own() {
    let (display, spans) = plan("```Go name:main.go hl:2\nfn\nx\n```\n```\n```");
    assert_eq!(display, "fn\nx\n");
    let blocks: Vec<_> = spans
        .iter()
        .filter(|span| matches!(span, StyleSpec::CodeBlock { .. }))
        .collect();
    assert_eq!(
        blocks,
        [
            &StyleSpec::CodeBlock {
                start: 0,
                end: 4,
                language: Some("Go".into()),
                name: Some("main.go".into()),
                line_count: 2,
            },
            &StyleSpec::CodeBlock {
                start: 5,
                end: 5,
                language: None,
                name: None,
                line_count: 1,
            },
        ]
    );
    let lines: Vec<_> = spans
        .iter()
        .filter_map(|span| match span {
            StyleSpec::Code {
                start,
                end,
                line_number,
                mark,
                first,
                last,
            } => Some((*start, *end, *line_number, *mark, *first, *last)),
            _ => None,
        })
        .collect();
    assert_eq!(
        lines,
        [
            (0, 3, 1, None, true, false),
            (3, 5, 2, Some(CodeLineMark::Highlight), false, true),
            (5, 5, 1, None, true, true),
        ]
    );
}

#[test]
fn a_window_sliding_through_a_long_block_keeps_its_block_whole() {
    let code: String = (1..=300).map(|i| format!("line {i}\n")).collect();
    let session = EditorSession::open(&format!("```rust\n{code}```\nafter"));
    let display = session.display_text();
    let mirror = DisplayMirror::new(&display);
    let whole = windowed(&session, &mirror, 0, display.len());
    for line in [1, 150, 300] {
        let at = display.find(&format!("line {line}\n")).unwrap();
        let spans = windowed(&session, &mirror, at, at + 4);
        assert_blocks_stay_whole(&spans, &whole);
        let line_numbers: Vec<u32> = spans
            .iter()
            .filter_map(|span| match span {
                StyleSpec::Code { line_number, .. } => Some(*line_number),
                _ => None,
            })
            .collect();
        let line_counts: Vec<u32> = spans
            .iter()
            .filter_map(|span| match span {
                StyleSpec::CodeBlock { line_count, .. } => Some(*line_count),
                _ => None,
            })
            .collect();
        assert_eq!((line_numbers, line_counts), (vec![line], vec![300]));
    }
}
