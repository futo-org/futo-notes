use super::plan;
use futo_notes_editor::host::{ListMarker, StyleSpec};

#[test]
fn list_style_levels_normalize_source_whitespace_and_plain_rows() {
    for unit in ["\t", "  ", "    "] {
        let (_, spans) = plan(&format!(
            "- root\n{unit}- child\n{unit}{unit}- leaf\n{unit}plain"
        ));
        let rows: Vec<_> = spans
            .into_iter()
            .filter_map(|span| match span {
                StyleSpec::ListRow {
                    indent,
                    level,
                    marker,
                    ..
                } => Some((indent, level, marker)),
                _ => None,
            })
            .collect();
        let width = if unit == "  " { 2 } else { 4 };
        assert_eq!(
            rows,
            [
                (0, 0, ListMarker::Bullet),
                (width, 1, ListMarker::Bullet),
                (2 * width, 2, ListMarker::Bullet),
                (width, 1, ListMarker::Plain)
            ]
        );
    }
}
