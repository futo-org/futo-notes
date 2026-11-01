//! Rank and select over rows that are not `through` rows, so a cut block's
//! first and last rows are found in logarithmic time (#314).
use super::{count, Link, Rows};

pub(super) fn heads(link: &Link) -> usize {
    link.as_ref().map_or(0, |n| n.heads)
}

impl Rows {
    /// The nearest row before `index` that is not a `through` row.
    pub fn block_start(&self, index: usize) -> usize {
        self.head(self.heads_through(index - 1)).unwrap_or(0)
    }
    /// The nearest row after `index` that is not a `through` row.
    pub fn block_end(&self, index: usize) -> usize {
        self.head(self.heads_through(index) + 1)
            .unwrap_or(self.len() - 1)
    }
    /// Head rows among rows `0..=index`.
    fn heads_through(&self, mut index: usize) -> usize {
        let mut node = self.root.as_deref();
        let mut total = 0;
        while let Some(n) = node {
            crate::inline::visit_container();
            let left = count(&n.left);
            if index < left {
                node = n.left.as_deref();
            } else {
                total += heads(&n.left) + usize::from(!n.row.through);
                if index == left {
                    return total;
                }
                index -= left + 1;
                node = n.right.as_deref();
            }
        }
        total
    }
    /// The index of the `rank`-th head row (1-based).
    fn head(&self, mut rank: usize) -> Option<usize> {
        let mut node = self.root.as_deref();
        let mut index = 0;
        while let Some(n) = node {
            crate::inline::visit_container();
            let left = heads(&n.left);
            if rank <= left {
                node = n.left.as_deref();
                continue;
            }
            rank -= left;
            index += count(&n.left);
            if !n.row.through {
                if rank == 1 {
                    return Some(index);
                }
                rank -= 1;
            }
            index += 1;
            node = n.right.as_deref();
        }
        None
    }
}
