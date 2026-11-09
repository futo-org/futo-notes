//! Paragraph-relative coordinates in a length-indexed sequence tree. Changing a
//! paragraph never rewrites the offsets of the paragraphs following it.
use super::row::Row;
mod heads;
mod table_scan;
#[cfg(test)]
mod table_scan_tests;
use heads::heads;

type Link = Option<Box<Node>>;
pub(crate) struct Node {
    pub row: Row,
    left: Link,
    right: Link,
    priority: u64,
    count: usize,
    source: usize,
    display: usize,
    /// Rows in this subtree that are not `through` rows.
    heads: usize,
    wikilinks: u64,
    table_scan: crate::table::Summary,
}

impl Node {
    fn update(&mut self) {
        self.table_scan = self
            .left
            .as_ref()
            .map_or_else(Default::default, |node| node.table_scan)
            .then(self.row.table_scan.summary)
            .then(
                self.right
                    .as_ref()
                    .map_or_else(Default::default, |node| node.table_scan),
            );
        self.wikilinks = [&self.left, &self.right]
            .into_iter()
            .flatten()
            .fold(self.row.wikilink_mask, |mask, child| mask | child.wikilinks);
        self.count = 1 + count(&self.left) + count(&self.right);
        self.heads = usize::from(!self.row.through) + heads(&self.left) + heads(&self.right);
        self.source = self.row.source_len + length(&self.left, false) + length(&self.right, false);
        self.display =
            self.row.display.len() + length(&self.left, true) + length(&self.right, true);
    }
}
fn count(link: &Link) -> usize {
    link.as_ref().map_or(0, |n| n.count)
}
fn length(link: &Link, display: bool) -> usize {
    link.as_ref()
        .map_or(0, |n| if display { n.display } else { n.source })
}
fn merge(left: Link, right: Link) -> Link {
    match (left, right) {
        (None, other) | (other, None) => other,
        (Some(mut a), Some(mut b)) => {
            if a.priority > b.priority {
                a.right = merge(a.right.take(), Some(b));
                a.update();
                Some(a)
            } else {
                b.left = merge(Some(a), b.left.take());
                b.update();
                Some(b)
            }
        }
    }
}
fn split(link: Link, at: usize) -> (Link, Link) {
    let Some(mut node) = link else {
        return (None, None);
    };
    let left_count = count(&node.left);
    if at <= left_count {
        let (a, b) = split(node.left.take(), at);
        node.left = b;
        node.update();
        (a, Some(node))
    } else {
        let (a, b) = split(node.right.take(), at - left_count - 1);
        node.right = a;
        node.update();
        (Some(node), b)
    }
}

#[derive(Default)]
pub(crate) struct Rows {
    root: Link,
    serial: u64,
}
impl Rows {
    pub fn len(&self) -> usize {
        count(&self.root)
    }
    pub fn replace(&mut self, start: usize, end: usize, rows: Vec<Row>) {
        let (a, rest) = split(self.root.take(), start);
        let (retired, b) = split(rest, end - start);
        crate::parallel::drop_large(retired, end - start);
        let mut middle = None;
        for row in rows {
            // SplitMix64 supplies stable, well-distributed heap priorities.
            self.serial = self.serial.wrapping_add(0x9e3779b97f4a7c15);
            let mut priority = self.serial;
            priority = (priority ^ (priority >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
            priority = (priority ^ (priority >> 27)).wrapping_mul(0x94d049bb133111eb);
            priority ^= priority >> 31;
            let node = Box::new(Node {
                heads: usize::from(!row.through),
                wikilinks: row.wikilink_mask,
                table_scan: row.table_scan.summary,
                source: row.source_len,
                display: row.display.len(),
                row,
                priority,
                count: 1,
                left: None,
                right: None,
            });
            middle = merge(middle, Some(node));
        }
        self.root = merge(merge(a, middle), b);
    }
    pub fn at(&self, index: usize) -> (&Row, usize, usize) {
        let (row, source, display, _) = self.at_with_work(index);
        (row, source, display)
    }
    pub fn at_with_work(&self, mut index: usize) -> (&Row, usize, usize, usize) {
        let mut node = self.root.as_deref().unwrap();
        let (mut source, mut display, mut work) = (0, 0, 0);
        loop {
            work += 1;
            let n = count(&node.left);
            if index < n {
                node = node.left.as_deref().unwrap();
            } else {
                source += length(&node.left, false);
                display += length(&node.left, true);
                if index == n {
                    return (&node.row, source, display, work);
                }
                index -= n + 1;
                source += node.row.source_len;
                display += node.row.display.len();
                node = node.right.as_deref().unwrap();
            }
        }
    }
    /// One indexed physical-source query with its actual node visits.
    pub fn source_row_with_work(&self, offset: usize) -> (&Row, usize, usize, usize) {
        self.row_with_work(offset, false)
    }
    pub fn display_row_with_work(&self, offset: usize) -> (&Row, usize, usize, usize) {
        self.row_with_work(offset, true)
    }
    fn row_with_work(&self, mut offset: usize, displayed: bool) -> (&Row, usize, usize, usize) {
        let mut node = self.root.as_deref().unwrap();
        let (mut source, mut display, mut work) = (0, 0, 0);
        loop {
            work += 1;
            let left = length(&node.left, displayed);
            let own = if displayed {
                node.row.display.len()
            } else {
                node.row.source_len
            };
            if offset < left {
                node = node.left.as_deref().unwrap();
            } else if offset < left + own || node.right.is_none() {
                return (
                    &node.row,
                    source + length(&node.left, false),
                    display + length(&node.left, true),
                    work,
                );
            } else {
                offset -= left + own;
                source += length(&node.left, false) + node.row.source_len;
                display += length(&node.left, true) + node.row.display.len();
                node = node.right.as_deref().unwrap();
            }
        }
    }
    /// Same physical-source lookup policy, mutating metadata only; lengths and
    /// tree sums remain unchanged. Report each actually visited indexed node.
    pub fn source_metadata_mut_with_work(&mut self, mut offset: usize) -> (&mut Row, usize, usize) {
        let mut node = self.root.as_deref_mut().unwrap();
        let (mut source, mut work) = (0, 0);
        loop {
            work += 1;
            let left = length(&node.left, false);
            if offset < left {
                node = node.left.as_deref_mut().unwrap();
            } else if offset < left + node.row.source_len || node.right.is_none() {
                return (&mut node.row, source + left, work);
            } else {
                offset -= left + node.row.source_len;
                source += left + node.row.source_len;
                node = node.right.as_deref_mut().unwrap();
            }
        }
    }
    /// Mutating transient metadata never changes indexed source/display lengths.
    pub fn metadata_mut_with_work(&mut self, mut index: usize) -> (&mut Row, usize) {
        let mut node = self.root.as_deref_mut().unwrap();
        let mut work = 0;
        loop {
            work += 1;
            let left = count(&node.left);
            if index < left {
                node = node.left.as_deref_mut().unwrap();
            } else if index == left {
                return (&mut node.row, work);
            } else {
                index -= left + 1;
                node = node.right.as_deref_mut().unwrap();
            }
        }
    }
    /// Rows in order whose links may carry a leaf in `mask`, with their source
    /// and display offsets. Subtrees without such a leaf are never entered.
    pub fn wikilink_rows(&self, mask: u64, visit: &mut dyn FnMut(&Row, usize, usize)) -> usize {
        fn walk(
            link: &Link,
            mask: u64,
            base: (usize, usize),
            visit: &mut dyn FnMut(&Row, usize, usize),
        ) -> usize {
            let Some(node) = link.as_deref().filter(|node| node.wikilinks & mask != 0) else {
                return 0;
            };
            let mut entered = 1 + walk(&node.left, mask, base, visit);
            let own = (
                base.0 + length(&node.left, false),
                base.1 + length(&node.left, true),
            );
            if node.row.wikilink_mask & mask != 0 {
                visit(&node.row, own.0, own.1);
            }
            let right = (own.0 + node.row.source_len, own.1 + node.row.display.len());
            entered += walk(&node.right, mask, right, visit);
            entered
        }
        walk(&self.root, mask, (0, 0), visit)
    }
    pub fn locate(&self, offset: usize, display: bool) -> usize {
        self.locate_with_work(offset, display).0
    }
    pub fn locate_with_work(&self, mut offset: usize, display: bool) -> (usize, usize) {
        let mut node = self.root.as_deref().unwrap();
        let (mut index, mut work) = (0, 0);
        loop {
            work += 1;
            let left = length(&node.left, display);
            let own = if display {
                node.row.display.len()
            } else {
                node.row.source_len
            };
            if offset < left {
                node = node.left.as_deref().unwrap();
            } else if offset < left + own || node.right.is_none() {
                return (index + count(&node.left), work);
            } else {
                offset -= left + own;
                index += count(&node.left) + 1;
                node = node.right.as_deref().unwrap();
            }
        }
    }
}
