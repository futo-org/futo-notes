use super::{StyleSpec, TableCellSpan};
use crate::{DisplayRange, TableDescription};

/// Tables as grid spans in the host's UTF-16 units: one `TableRow` per physical row line (cells
/// carry their content range and the delimiter row's alignment) and a `TableDelimiter` for the
/// delimiter line. Every number is the engine's: a host draws a grid and never reads pipes.
/// `to_utf16` converts a display byte offset of the whole display.
///
/// `window` is the display range the host is restyling. It resets the window to the base look
/// and applies these spans, so rows outside it keep what they have: only the rows whose line
/// meets the window are planned, which keeps a keystroke in a 20,000-row table from re-planning
/// and re-drawing every row. A body row's span depends on nothing but its own line, the
/// header's column count and the delimiter's alignments, so a window that meets the header or
/// the delimiter line plans the whole table (an edit there changes every row).
pub fn plan_tables(
    tables: &[TableDescription],
    window: DisplayRange,
    to_utf16: &mut dyn FnMut(usize) -> usize,
) -> Vec<StyleSpec> {
    let meets = |line: &DisplayRange| line.start.0 <= window.end.0 && window.start.0 <= line.end.0;
    let mut out = Vec::new();
    for table in tables {
        let whole = table.row_lines.first().is_some_and(meets)
            || table.delimiter_line.as_ref().is_some_and(meets);
        let table_start = to_utf16(table.display.start.0);
        for (index, row) in table.rows.iter().enumerate() {
            let Some(line) = table.row_lines.get(index) else {
                continue;
            };
            if !whole && !meets(line) {
                continue;
            }
            let cells: Vec<TableCellSpan> = row
                .iter()
                .map(|cell| TableCellSpan {
                    column: cell.column,
                    start: to_utf16(cell.content.start.0),
                    end: to_utf16(cell.content.end.0),
                    alignment: table
                        .alignments
                        .get(cell.column)
                        .copied()
                        .unwrap_or(crate::TableAlignment::None),
                })
                .collect();
            out.push(StyleSpec::TableRow {
                start: to_utf16(line.start.0),
                end: to_utf16(line.end.0),
                columns: table.columns,
                header: index == 0,
                table_start,
                cells,
            });
            if index == 0 {
                if let Some(delimiter) = table.delimiter_line {
                    out.push(StyleSpec::TableDelimiter {
                        start: to_utf16(delimiter.start.0),
                        end: to_utf16(delimiter.end.0),
                    });
                }
            }
        }
    }
    out
}
