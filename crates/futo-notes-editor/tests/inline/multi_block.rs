//! A selection over several blocks toggles each block's visible inline body
//! on its own, in one direction for the whole selection, as one Undo step.
use super::*;
use futo_notes_editor::InlineFormat::{self, Bold, Italic};

/// Select all, toggle once (one acceptance), check the exact result, then
/// Undo back to the exact opening source and selection.
fn toggle_all(original: &str, format: InlineFormat, expected: &str) {
    let mut s = EditorSession::open(original);
    let mut view = ReferenceView::new(&s.display_text());
    let all = range(0, view.text.len());
    s.select(s.revision(), all).unwrap();
    let mut accepted = 0;
    let change = s
        .toggle_format(s.revision(), format, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap_or_else(|error| panic!("{original:?}: {error:?}"))
        .unwrap();
    view.apply(change);
    assert_eq!(s.source_text(), expected, "{original:?}");
    assert_eq!(accepted, 1, "{original:?}: one host acceptance");
    assert_eq!(s.selection(), all, "{original:?}: selection kept");
    assert_fresh(&s, &view);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), original, "{original:?}: Undo");
    assert_eq!(s.selection(), all, "{original:?}: Undo selection");
    assert_fresh(&s, &view);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected, "{original:?}: Redo");
}

fn lit(source: &str) -> Vec<InlineFormat> {
    let mut s = EditorSession::open(source);
    s.select(s.revision(), range(0, s.display_text().len()))
        .unwrap();
    s.toolbar_state().formats
}

#[test]
fn bold_over_lists_and_tasks_formats_each_item_body() {
    toggle_all("- apples\n- pears", Bold, "- **apples**\n- **pears**");
    toggle_all(
        "intro\n\n- apples\n- pears",
        Bold,
        "**intro**\n\n- **apples**\n- **pears**",
    );
    toggle_all("- [ ] a\n- [x] b", Bold, "- [ ] **a**\n- [x] **b**");
    toggle_all("- a\n  - b\n- c", Bold, "- **a**\n  - **b**\n- **c**");
    toggle_all("1. one\n2. two", Bold, "1. **one**\n2. **two**");
}

#[test]
fn toggling_a_format_every_body_carries_removes_it_everywhere() {
    toggle_all("- **a**\n- **b**", Bold, "- a\n- b");
    toggle_all("**hello**\n\n**world**", Bold, "hello\n\nworld");
    toggle_all(
        "# **Title**\n\n**hello world**",
        Bold,
        "# Title\n\nhello world",
    );
    toggle_all("> **quoted**\n\n**plain**", Bold, "> quoted\n\nplain");
    toggle_all("**a `x` b**\n\n**c**", Bold, "a `x` b\n\nc");
}

#[test]
fn a_partly_formatted_selection_adds_the_format_everywhere() {
    toggle_all("hello\n\nworld", Bold, "**hello**\n\n**world**");
    toggle_all("**a**\n\nb", Bold, "**a**\n\n**b**");
    toggle_all(
        "# H\n\n- a\n- b\n\npara",
        Italic,
        "# *H*\n\n- *a*\n- *b*\n\n*para*",
    );
    toggle_all("> quoted\n\nplain", Bold, "> **quoted**\n\n**plain**");
}

#[test]
fn table_cells_are_formatted_one_cell_at_a_time() {
    toggle_all(
        "| a | b |\n|---|---|\n| 1 | 2 |",
        Bold,
        "| **a** | **b** |\n|---|---|\n| **1** | **2** |",
    );
    toggle_all(
        "| **a** | **b** |\n|---|---|\n| **1** | **2** |",
        Bold,
        "| a | b |\n|---|---|\n| 1 | 2 |",
    );
}

#[test]
fn code_fences_between_bodies_stay_untouched() {
    toggle_all(
        "left\n\n~~~x\nraw\n~~~\n\nright",
        Bold,
        "**left**\n\n~~~x\nraw\n~~~\n\n**right**",
    );
    toggle_all(
        "- a\n\n```\ncode\n```\n\n# b",
        Italic,
        "- *a*\n\n```\ncode\n```\n\n# *b*",
    );
}

#[test]
fn the_lit_state_predicts_a_multi_block_toggle() {
    assert_eq!(lit("**hello**\n\n**world**"), vec![Bold]);
    assert_eq!(lit("- **a**\n- **b**"), vec![Bold]);
    assert_eq!(lit("# **Title**\n\n**hello world**"), vec![Bold]);
    assert!(lit("**a**\n\nb").is_empty());
    assert!(lit("- apples\n- pears").is_empty());
    // A single block keeps the whole-selection rule.
    assert!(lit("**bold** plain").is_empty());
}

#[test]
fn a_select_all_toggle_costs_work_linear_in_the_note() {
    let mut per_section = Vec::new();
    for count in [250, 1_000] {
        let source: String = (0..count)
            .map(|i| format!("## Section {i}\n\nBody line {i} with **bold**.\n\n"))
            .collect();
        let mut s = EditorSession::open(&source);
        s.select(s.revision(), range(0, s.display_text().len()))
            .unwrap();
        let change = s
            .toggle_format(s.revision(), Bold, &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert!(s
            .source_text()
            .starts_with("## **Section 0**\n\n**Body line 0 with bold.**"));
        let work = change.work;
        per_section.push([
            work.parsed_source_bytes / count,
            work.materialized_source_bytes / count,
            work.link_metadata_items / count,
        ]);
    }
    for (small, large) in per_section[0].iter().zip(&per_section[1]) {
        assert!(
            *large <= small + small / 2,
            "per-section work: {per_section:?}"
        );
    }
}
