//! The real treap is checked against a fresh canonical scan after replacements.
use super::{Row, Rows};
use crate::table::{RowScan, State};
use std::sync::Arc;
fn row(text: &str) -> Row {
    Row::parse_with_references(text, &Arc::new(Default::default()), &[])
}
fn check(rows: &Rows, parts: &[String]) {
    let source = parts.concat();
    let scan = RowScan::new(&source);
    for at in 0..=source.len() {
        assert_eq!(
            rows.table_state_at(at).0,
            scan.prefix(at).0.apply(State::Searching(None)),
            "{source:?} at {at}"
        );
    }
}
#[test]
fn split_merge_and_replacement_keep_scan_offsets_and_cross_row_rules_current() {
    let original = [
        "h|t\n",
        "-|-\n",
        "alpha be",
        "ta gamma\n",
        "c|d|e\n",
        "-|-|-\n",
        "x|y|z",
        "",
    ];
    let mut parts: Vec<String> = original.iter().map(|text| (*text).into()).collect();
    let mut rows = Rows::default();
    rows.replace(0, 0, parts.iter().map(|text| row(text)).collect());
    check(&rows, &parts);
    // Invalidate a rule whose distant body rows remain retained.
    rows.replace(1, 2, vec![row("invalid\n")]);
    parts[1] = "invalid\n".into();
    check(&rows, &parts);
    // Insert an interruption and a fresh cross-row header/rule pair.
    let added = ["# stop\n", "u|v\n", "-|-\n"];
    rows.replace(4, 4, added.iter().map(|text| row(text)).collect());
    parts.splice(4..4, added.iter().map(|text| (*text).into()));
    check(&rows, &parts);
    // Replacement and removal shift every later local header's source base.
    rows.replace(
        0,
        1,
        vec![row("intro\n"), row("intro|text\n"), row("h|t\n")],
    );
    parts.splice(
        0..1,
        ["intro\n", "intro|text\n", "h|t\n"]
            .iter()
            .map(|text| (*text).into()),
    );
    check(&rows, &parts);
    rows.replace(2, 5, vec![row("\n")]);
    parts.splice(2..5, ["\n".into()]);
    check(&rows, &parts);
    // Undo-like exact replacement rebuilds leaves under different priorities.
    rows.replace(
        0,
        rows.len(),
        original.iter().map(|text| row(text)).collect(),
    );
    parts = original.iter().map(|text| (*text).into()).collect();
    check(&rows, &parts);
}
