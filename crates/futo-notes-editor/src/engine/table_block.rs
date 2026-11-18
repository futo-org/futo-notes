//! The table a shown table line belongs to. Delimiter rows and the lines
//! that end tables alternate and the store counts them
//! (`Size::table_edges`), so a line's table is found in the store's index
//! and its width in the chunks' own counts, never by walking its rows.
use super::commands::tables::{alignments, Row};
use super::line::Entry;
use super::store::{self, Store};
use crate::lines::{Kind, TableRole};
use crate::{
    DisplayOffset, DisplayRange, TableBlockDescription, TableLineDescription, TableLineRole,
};

pub(super) struct TableBlock {
    pub header: usize,
    pub delimiter: usize,
    pub last: usize,
    pub description: TableBlockDescription,
}

/// Line `entry`'s place in a table, when it is a table line.
pub(super) fn table_role(entry: &Entry) -> Option<TableRole> {
    match entry.line.kind {
        Kind::Table { role, .. } => Some(role),
        _ => None,
    }
}

impl TableBlock {
    /// The table of line `index`, a table line (`table_role`).
    pub fn holding(store: &Store, index: usize) -> Self {
        let delimiter = match table_role(store.get(index)) {
            Some(TableRole::Header) => index + 1,
            Some(TableRole::Delimiter) => index,
            _ => {
                // The edges before a row end with its delimiter row.
                let edges = store.before(index).table_edges;
                let (delimiter, _) = store
                    .line_past(store::table_edges, edges - 1)
                    .expect("a table row's delimiter row");
                delimiter
            }
        };
        let header = delimiter - 1;
        let edges = store.before(delimiter).table_edges + 1;
        let last = store
            .line_past(store::table_edges, edges)
            .map_or(store.len() - 1, |(closer, _)| closer - 1);
        let columns = store.widest_line(header..last + 1);
        let start = store.before(delimiter).source;
        let entry = store.get(delimiter);
        let end = store.before(last).display + store.get(last).shown_len();
        let description = TableBlockDescription {
            range: DisplayRange {
                start: DisplayOffset(store.before(header).display),
                end: DisplayOffset(end),
            },
            columns,
            alignments: alignments(&Row::read(entry, delimiter, start), entry, columns),
        };
        Self {
            header,
            delimiter,
            last,
            description,
        }
    }

    pub fn holds(&self, index: usize) -> bool {
        self.header <= index && index <= self.last
    }

    /// Line `index` of this table, `entry`, shown at `display`.
    pub fn line(&self, index: usize, entry: &Entry, display: usize) -> TableLineDescription {
        let row = Row::read(entry, index, 0);
        let shown = |at: usize| DisplayOffset(display + entry.to_display(at));
        let role = if index == self.header {
            TableLineRole::Header
        } else if index == self.delimiter {
            TableLineRole::Delimiter
        } else {
            TableLineRole::Row
        };
        TableLineDescription {
            role,
            row: index.saturating_sub(self.delimiter),
            cells: row
                .contents
                .iter()
                .map(|content| DisplayRange {
                    start: shown(content.start),
                    end: shown(content.end),
                })
                .collect(),
            pipes: row.pipes.iter().map(|&pipe| shown(pipe)).collect(),
        }
    }
}
