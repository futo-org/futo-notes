//! Rank and select over rows that are not `through` rows, so a cut block's
//! first and last rows are found in logarithmic time (#314).
use super::{count, Link, Rows};

pub(super) fn heads(link: &Link) -> usize {
    link.as_ref().map_or(0, |n| n.heads)
}

impl Rows {
    /// The nearest row before `index` that is not a `through` row.
    pub fn block_start(&self, index: usize) -> usize {
        self.block_start_with_work(index).0
    }
    /// The nearest row after `index` that is not a `through` row.
    pub fn block_end(&self, index: usize) -> usize {
        self.block_end_with_work(index).0
    }
    pub fn block_start_with_work(&self, index: usize) -> (usize, usize) {
        let (rank, a) = self.heads_through_with_work(index - 1);
        let (head, b) = self.head_with_work(rank);
        (head.unwrap_or(0), a + b)
    }
    pub fn block_end_with_work(&self, index: usize) -> (usize, usize) {
        let (rank, a) = self.heads_through_with_work(index);
        let (head, b) = self.head_with_work(rank + 1);
        (head.unwrap_or(self.len() - 1), a + b)
    }
    /// Head rows among rows `0..=index`, with actual node visits.
    fn heads_through_with_work(&self, mut index: usize) -> (usize, usize) {
        let mut node = self.root.as_deref();
        let (mut total, mut work) = (0, 0);
        while let Some(n) = node {
            work += 1;
            let left = count(&n.left);
            if index < left {
                node = n.left.as_deref();
            } else {
                total += heads(&n.left) + usize::from(!n.row.through);
                if index == left {
                    return (total, work);
                }
                index -= left + 1;
                node = n.right.as_deref();
            }
        }
        (total, work)
    }
    /// The index of the `rank`-th head row (1-based), with actual node visits.
    fn head_with_work(&self, mut rank: usize) -> (Option<usize>, usize) {
        let mut node = self.root.as_deref();
        let (mut index, mut work) = (0, 0);
        while let Some(n) = node {
            work += 1;
            let left = heads(&n.left);
            if rank <= left {
                node = n.left.as_deref();
                continue;
            }
            rank -= left;
            index += count(&n.left);
            if !n.row.through {
                if rank == 1 {
                    return (Some(index), work);
                }
                rank -= 1;
            }
            index += 1;
            node = n.right.as_deref();
        }
        (None, work)
    }
}
