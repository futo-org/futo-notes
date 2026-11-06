use super::{StyleSpec, TableCellSpan};
use crate::TableDescription;

/// Tables as grid spans in the host's UTF-16 units: one `TableRow` per physical row line (cells
/// carry their content range and the delimiter row's alignment) and a `TableDelimiter` for the
/// delimiter line. Every number is the engine's: a host draws a grid and never reads pipes.
/// `to_utf16` converts a display byte offset of the whole display.
pub fn plan_tables(
    tables: &[TableDescription],
    to_utf16: &mut dyn FnMut(usize) -> usize,
) -> Vec<StyleSpec> {
    let mut out = Vec::new();
    for table in tables {
        let table_start = to_utf16(table.display.start.0);
        for (index, row) in table.rows.iter().enumerate() {
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
            let Some(line) = table.row_lines.get(index) else {
                continue;
            };
            if cells.is_empty() {
                continue;
            }
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
