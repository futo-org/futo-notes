//! A canonical scan prefix from immutable row facts and tree aggregates.
use super::Rows;
use crate::table::{State, Summary};
impl Rows {
    pub(crate) fn table_state_at(&self, mut at: usize) -> (State, usize) {
        let mut node = self.root.as_deref().expect("a projection has a row");
        let mut summary = Summary::default();
        let mut work = 0;
        loop {
            work += 1;
            let left = node.left.as_ref().map_or(0, |left| left.source);
            if at < left {
                node = node.left.as_deref().unwrap();
                continue;
            }
            if let Some(left) = &node.left {
                summary = summary.then(left.table_scan);
            }
            at -= left;
            if at < node.row.source_len || node.right.is_none() {
                let (prefix, visits) = node.row.table_scan.prefix(at);
                summary = summary.then(prefix);
                return (summary.apply(State::Searching(None)), work + visits);
            }
            summary = summary.then(node.row.table_scan.summary);
            at -= node.row.source_len;
            node = node.right.as_deref().unwrap();
        }
    }
}
