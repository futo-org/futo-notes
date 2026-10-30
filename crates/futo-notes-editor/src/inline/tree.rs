//! Paragraph-relative coordinates in a length-indexed sequence tree. Changing a
//! paragraph never rewrites the offsets of the paragraphs following it.
use super::row::Row;

type Link = Option<Box<Node>>;
pub(crate) struct Node {
    pub row: Row,
    left: Link,
    right: Link,
    priority: u64,
    count: usize,
    source: usize,
    display: usize,
    transparent_quote: Option<usize>,
}

impl Node {
    fn update(&mut self) {
        self.transparent_quote = self.row.transparent_quote.filter(|quote| {
            [&self.left, &self.right].into_iter().all(|link| {
                link.as_ref()
                    .is_none_or(|child| child.transparent_quote == Some(*quote))
            })
        });
        self.count = 1 + count(&self.left) + count(&self.right);
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
        let (_, b) = split(rest, end - start);
        let mut middle = None;
        for row in rows {
            // SplitMix64 supplies stable, well-distributed heap priorities.
            self.serial = self.serial.wrapping_add(0x9e3779b97f4a7c15);
            let mut priority = self.serial;
            priority = (priority ^ (priority >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
            priority = (priority ^ (priority >> 27)).wrapping_mul(0x94d049bb133111eb);
            priority ^= priority >> 31;
            let node = Box::new(Node {
                transparent_quote: row.transparent_quote,
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
    pub fn at(&self, mut index: usize) -> (&Row, usize, usize) {
        let mut node = self.root.as_deref().unwrap();
        let (mut source, mut display) = (0, 0);
        loop {
            let n = count(&node.left);
            if index < n {
                node = node.left.as_deref().unwrap();
            } else {
                source += length(&node.left, false);
                display += length(&node.left, true);
                if index == n {
                    return (&node.row, source, display);
                }
                index -= n + 1;
                source += node.row.source_len;
                display += node.row.display.len();
                node = node.right.as_deref().unwrap();
            }
        }
    }
    pub fn locate(&self, mut offset: usize, display: bool) -> usize {
        let mut node = self.root.as_deref().unwrap();
        let mut index = 0;
        loop {
            let left = length(&node.left, display);
            let own = if display {
                node.row.display.len()
            } else {
                node.row.source_len
            };
            if offset < left {
                node = node.left.as_deref().unwrap();
            } else if offset < left + own || node.right.is_none() {
                return index + count(&node.left);
            } else {
                offset -= left + own;
                index += count(&node.left) + 1;
                node = node.right.as_deref().unwrap();
            }
        }
    }
}

/// Only fixed-size canonical metadata crosses the semantic read boundary;
/// foreign physical-body vectors and source text stay with their parsed row.
pub(crate) struct ContextWitness {
    pub source: std::ops::Range<usize>,
    pub quote_depth: usize,
    pub code: bool,
    pub empty_comment: bool,
    pub list: Option<super::lists::ListLine>,
}

/// Search the retained interpretation, skipping blank-only subtrees. The work
/// count includes each visited tree node and binary-search context comparison.
impl Rows {
    pub fn context_neighbor(
        &self,
        at: usize,
        forward: bool,
        quote: usize,
    ) -> Option<ContextWitness> {
        fn search(
            link: &Link,
            base: usize,
            at: usize,
            forward: bool,
            quote: usize,
        ) -> Option<ContextWitness> {
            let node = link.as_ref()?;
            visit_context();
            if node.transparent_quote == Some(quote)
                || (forward && base + node.source <= at)
                || (!forward && base >= at)
            {
                return None;
            }
            let own = base + length(&node.left, false);
            let next = own + node.row.source_len;
            let first = if forward {
                (&node.left, base)
            } else {
                (&node.right, next)
            };
            if let Some(found) = search(first.0, first.1, at, forward, quote) {
                return Some(found);
            }
            if forward && next > at || !forward && own < at {
                let runs = &node.row.context;
                let index = runs.partition_point(|run| {
                    visit_context();
                    if forward {
                        own + run.source.end <= at
                    } else {
                        own + run.source.start < at
                    }
                });
                let mut index = if forward {
                    index
                } else {
                    index.saturating_sub(1)
                };
                if let Some(run) = runs.get(index) {
                    if run.transparent_quote == Some(quote) {
                        if forward {
                            index += 1;
                        } else if index > 0 {
                            index -= 1;
                        } else {
                            index = runs.len();
                        }
                    }
                    if let Some(run) = runs.get(index) {
                        visit_context();
                        let block = if forward { run.first } else { run.last };
                        let block = &node.row.blocks[block];
                        let mut list = block.list.clone();
                        if let Some(list) = &mut list {
                            list.shift(own);
                        }
                        return Some(ContextWitness {
                            source: own + block.source.start..own + block.source.end,
                            quote_depth: block.quote_depth,
                            code: block.code,
                            empty_comment: block.empty_comment,
                            list,
                        });
                    }
                }
            }
            let last = if forward {
                (&node.right, next)
            } else {
                (&node.left, base)
            };
            search(last.0, last.1, at, forward, quote)
        }
        search(&self.root, 0, at, forward, quote)
    }
}

#[cfg(test)]
thread_local! {
    pub(crate) static CONTEXT_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
fn visit_context() {
    #[cfg(test)]
    CONTEXT_VISITS.with(|visits| visits.set(visits.get() + 1));
}

#[cfg(test)]
mod context_work_tests {
    use super::CONTEXT_VISITS;
    use crate::{DisplayOffset, DisplayRange, EditorSession};

    #[test]
    fn shortcut_parser_work_does_not_include_distant_following_list_bodies() {
        for blanks in [9, 33] {
            for start in [2, 1000] {
                let mut baseline = None;
                for foreign_bytes in [8, 100_000] {
                    let gap = "\n".repeat(blanks + 1);
                    let body = "x".repeat(foreign_bytes);
                    let raw = format!("999. before{gap}{start}.body{gap}7. {body}\n1. tail");
                    let mut session = EditorSession::open(&raw);
                    let at = "before".len() + gap.len() + start.to_string().len() + 1;
                    let selected = DisplayRange {
                        start: DisplayOffset(at),
                        end: DisplayOffset(at),
                    };
                    session.select(session.revision(), selected).unwrap();
                    // Existing staging retains the preceding owner's trailing
                    // blank rows (#314). The new semantic witness must add no
                    // parser/materialization work when its body grows remotely.
                    let (window, _) = session.projection.edit_window(selected);
                    CONTEXT_VISITS.with(|visits| visits.set(0));
                    let change = session
                        .replace(session.revision(), selected, " ", &mut |_| Ok(()))
                        .unwrap();
                    let visits = CONTEXT_VISITS.with(|visits| visits.get());
                    assert!(
                        visits > 0 && visits < 160,
                        "gap={blanks} body={foreign_bytes} visits={visits}"
                    );
                    let measured = (
                        window.len(),
                        change.work.parsed_source_bytes,
                        change.work.materialized_source_bytes,
                    );
                    if let Some(baseline) = baseline {
                        assert_eq!(
                            measured, baseline,
                            "foreign source must not enter stage/parser input"
                        );
                    } else {
                        baseline = Some(measured);
                    }
                    if blanks == 9 {
                        assert!(change.work.parsed_source_bytes < 4096, "{:?}", change.work);
                        assert!(
                            change.work.materialized_source_bytes < 4096,
                            "{:?}",
                            change.work
                        );
                    }
                    let expected = if start == 2 {
                        format!("999. before{gap}2) body{gap}7. {body}\n1. tail")
                    } else {
                        format!(
                            "999. before{gap}1000. body\n<!-- -->\n{}7. {body}\n1. tail",
                            "\n".repeat(blanks)
                        )
                    };
                    assert_eq!(session.source_text(), expected);
                }
            }
        }
    }
}

#[cfg(test)]
mod neighbor_work_tests {
    use super::CONTEXT_VISITS;
    use crate::inline::Projection;

    #[test]
    fn semantic_neighbor_metadata_skips_large_blank_runs_and_both_foreign_bodies() {
        for blanks in [9, 1000, 20_000] {
            for body_bytes in [8, 100_000] {
                for quote in ["", "> ", "> > "] {
                    let body = "x".repeat(body_bytes);
                    let gap = format!("{}\n", quote.trim_end()).repeat(blanks);
                    let before = format!("{quote}999. {body}\n{gap}");
                    let target = format!("{quote}2.body\n");
                    let source = format!("{before}{target}{gap}{quote}7. {body}\n{quote}1. tail");
                    let projection = Projection::new(&source);
                    CONTEXT_VISITS.with(|visits| visits.set(0));
                    let preceding = projection
                        .rows
                        .context_neighbor(before.len(), false, quote.matches('>').count())
                        .unwrap();
                    let following = projection
                        .rows
                        .context_neighbor(
                            before.len() + target.len(),
                            true,
                            quote.matches('>').count(),
                        )
                        .unwrap();
                    let visits = CONTEXT_VISITS.with(|visits| visits.get());
                    assert!(
                        visits > 0 && visits < 160,
                        "blanks={blanks} body={body_bytes} quote={quote:?} visits={visits}"
                    );
                    assert_eq!(preceding.list.unwrap().ordinal, Some(999));
                    assert_eq!(following.list.unwrap().ordinal, Some(7));
                }
            }
        }
    }
}
