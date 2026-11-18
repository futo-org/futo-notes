use super::{StyleSpec, TableCellSpan};
use crate::{
    BlockDescription, DisplayRange, ProjectionSlice, TableAlignment, TableBlockDescription,
    TableLineRole,
};

/// The span of a table line `block` of `table`, in the host's UTF-16 units: a `TableRow` for the
/// header and each row (cells carry their content range and their column's alignment), a
/// `TableDelimiter` for the delimiter row. Every number is the engine's: a host draws a grid and
/// never reads pipes.
pub(super) fn plan_table_line(
    block: &BlockDescription,
    table: &TableBlockDescription,
    to_utf16: &mut dyn FnMut(usize) -> usize,
) -> Option<StyleSpec> {
    let line = block.table.as_ref()?;
    let (start, end) = (to_utf16(block.range.start.0), to_utf16(block.range.end.0));
    if line.role == TableLineRole::Delimiter {
        return Some(StyleSpec::TableDelimiter { start, end });
    }
    let alignment = |column: usize| {
        table
            .alignments
            .get(column)
            .copied()
            .unwrap_or(TableAlignment::None)
    };
    let cells = line
        .cells
        .iter()
        .enumerate()
        .map(|(column, cell)| TableCellSpan {
            column,
            start: to_utf16(cell.start.0),
            end: to_utf16(cell.end.0),
            alignment: alignment(column),
        })
        .collect();
    Some(StyleSpec::TableRow {
        start,
        end,
        columns: table.columns,
        header: line.role == TableLineRole::Header,
        row: line.row,
        table_start: to_utf16(table.range.start.0),
        cells,
        pipes: line.pipes.iter().map(|pipe| to_utf16(pipe.0)).collect(),
    })
}

/// The table of `slice` that table line `block` is in.
pub(super) fn table_of<'a>(
    slice: &'a ProjectionSlice,
    block: &BlockDescription,
) -> Option<&'a TableBlockDescription> {
    block.table.as_ref()?;
    let at = block.range.start.0;
    slice
        .tables
        .iter()
        .find(|table| table.range.start.0 <= at && at <= table.range.end.0)
}

/// The span of a table the window touches, whole.
pub(super) fn plan_table(
    table: &TableBlockDescription,
    to_utf16: &mut dyn FnMut(usize) -> usize,
) -> StyleSpec {
    StyleSpec::Table {
        start: to_utf16(table.range.start.0),
        end: to_utf16(table.range.end.0),
        columns: table.columns,
        alignments: table.alignments.clone(),
    }
}

/// The display range a host plans for a restyle window whose projection is `slice`: the window,
/// widened to every table whose header or delimiter row it describes. A row's span carries its
/// table's columns and alignments, so an edit there replans every row; a window inside a table's
/// body plans only the rows it meets, which keeps a keystroke in a 20,000-row table from
/// re-planning every row.
pub fn table_window(slice: &ProjectionSlice) -> DisplayRange {
    let mut window = slice.range;
    for block in &slice.blocks {
        let row = block.table.as_ref().map(|line| line.role) == Some(TableLineRole::Row);
        let Some(table) = table_of(slice, block).filter(|_| !row) else {
            continue;
        };
        window.start.0 = window.start.0.min(table.range.start.0);
        window.end.0 = window.end.0.max(table.range.end.0);
    }
    window
}
