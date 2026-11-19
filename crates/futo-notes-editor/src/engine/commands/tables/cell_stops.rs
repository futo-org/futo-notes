//! A header or body row's pipes and cell padding are hidden: a caret the
//! user places never rests inside a row's spelling, only in a cell's
//! content or at the row's ends. `move_caret` still steps over every
//! character of the row.
use super::super::super::{store, Engine};
use super::{role, Row};
use crate::lines::TableRole;
use crate::DisplayRange;
use std::cmp::Ordering;

impl Engine {
    /// Where a caret placed at display offset `at` rests: inside a header or
    /// body row's spelling, at the nearest cell content edge the way it
    /// travelled from the selection `from` (a caret before `at`, the next
    /// cell's start; after it, the previous cell's end), or the row's end
    /// that way where no cell lies that way, so a caret swiped one step at a
    /// time leaves the row; the nearer edge (the next cell's, on a tie) when
    /// `from` is `at` or a range; anywhere else at `at`.
    pub(crate) fn cell_stop(&self, at: usize, from: DisplayRange) -> usize {
        let (index, before) = self.line_at_display(store::display, at);
        let entry = self.line(index);
        if !matches!(role(entry), Some(TableRole::Header | TableRole::Row)) {
            return at;
        }
        let local = at - before.display;
        if local == 0 || local >= entry.shown_len() {
            return at;
        }
        let contents: Vec<(usize, usize)> = Row::read(entry, index, 0)
            .contents
            .iter()
            .map(|content| {
                (
                    entry.to_display(content.start),
                    entry.to_display(content.end),
                )
            })
            .collect();
        if contents
            .iter()
            .any(|&(start, end)| start <= local && local <= end)
        {
            return at;
        }
        let ahead = contents
            .iter()
            .find(|(start, _)| *start > local)
            .map(|(start, _)| *start);
        let behind = contents
            .iter()
            .rev()
            .find(|(_, end)| *end < local)
            .map(|(_, end)| *end);
        let travelled = (from.start == from.end).then(|| from.start.0.cmp(&at));
        let stop = match (travelled, ahead, behind) {
            (Some(Ordering::Less), ahead, _) => ahead.unwrap_or(entry.shown_len()),
            (Some(Ordering::Greater), _, behind) => behind.unwrap_or(0),
            (_, Some(ahead), Some(behind)) if local - behind < ahead - local => behind,
            (_, Some(ahead), _) => ahead,
            (_, None, Some(behind)) => behind,
            (_, None, None) => return at,
        };
        before.display + stop
    }
}
