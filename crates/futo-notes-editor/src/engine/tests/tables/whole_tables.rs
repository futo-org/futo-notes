//! A selection covering every cell of a table, cut and pasted over. The
//! keys and typing over it are cases in `whole-table.json`.
use super::super::ok;
use super::{marked, open};
use crate::EditorError;

const COVERED: &str = "a\n| «x | y |\n|---|---|\n| 1 | 2» |\nb";

#[test]
fn cut_over_every_cell_copies_and_removes_the_table_whole() {
    let mut engine = open(COVERED);
    let (source, _) = marked(COVERED);
    let selection = engine.selection();
    let (copied, change) = engine
        .cut_markdown(engine.revision(), selection, &mut ok)
        .unwrap();
    assert_eq!(copied, "| x | y |\n|---|---|\n| 1 | 2 |");
    assert!(change.is_some());
    assert_eq!(engine.source_text(), "a\n\nb");
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), source);
    assert_eq!(engine.selection(), selection);
}

/// Paste over a range from a table line across cells is refused before it
/// is planned (the table family's paste rule), so it does not take the
/// table whole; from a line above the table it is planned, and does.
#[test]
fn paste_over_every_cell_is_refused_from_a_table_line_only() {
    let mut engine = open(COVERED);
    let (source, _) = marked(COVERED);
    let selection = engine.selection();
    let refused = engine.paste_markdown(engine.revision(), selection, "z", &mut ok);
    assert!(matches!(refused, Err(EditorError::UnrepresentableFormat)));
    assert_eq!(engine.source_text(), source);

    for (pasted, want) in [("z", "abz\nd"), ("z\nw", "abz\nw\nd")] {
        let mut engine = open("ab«c\n| x |\n|---|\n| 1» |\nd");
        let selection = engine.selection();
        engine
            .paste_markdown(engine.revision(), selection, pasted, &mut ok)
            .unwrap();
        assert_eq!(engine.source_text(), want, "{pasted:?}");
    }
}

/// An opening pair typed over the selection formats each cell, as the
/// format toggles do over cells: the table stays.
#[test]
fn a_pair_typed_over_every_cell_keeps_the_table() {
    let mut engine = open(COVERED);
    let selection = engine.selection();
    engine
        .paired_input(engine.revision(), selection, "*", &mut ok)
        .unwrap();
    assert_eq!(
        engine.source_text(),
        "a\n| *x* | *y* |\n|---|---|\n| *1* | *2* |\nb"
    );
}
