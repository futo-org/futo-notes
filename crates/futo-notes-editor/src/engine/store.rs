//! The note's lines in chunks, with a Fenwick tree over chunk sizes so that
//! finding the line at an offset, or the offsets before a line, never walks
//! the note.
use super::line::Entry;
use std::ops::Range;

/// Lines a chunk is cut to when chunks are rebuilt.
const TARGET: usize = 64;
/// A chunk longer than this is cut again.
const MAX: usize = 128;
/// A chunk shorter than this is merged with the next one when rebuilt.
const MIN: usize = 16;

/// What a line (or a run of lines) measures.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Size {
    pub lines: usize,
    pub source: usize,
    pub display: usize,
    pub source16: usize,
    pub display16: usize,
}

impl Size {
    fn plus(self, other: Size) -> Size {
        Size {
            lines: self.lines + other.lines,
            source: self.source + other.source,
            display: self.display + other.display,
            source16: self.source16 + other.source16,
            display16: self.display16 + other.display16,
        }
    }

    fn minus(self, other: Size) -> Size {
        Size {
            lines: self.lines - other.lines,
            source: self.source - other.source,
            display: self.display - other.display,
            source16: self.source16 - other.source16,
            display16: self.display16 - other.display16,
        }
    }
}

/// One of the measures in a [`Size`].
pub(crate) type Measure = fn(&Size) -> usize;

pub(crate) fn source(size: &Size) -> usize {
    size.source
}
pub(crate) fn display(size: &Size) -> usize {
    size.display
}
pub(crate) fn source16(size: &Size) -> usize {
    size.source16
}
pub(crate) fn display16(size: &Size) -> usize {
    size.display16
}
fn lines(size: &Size) -> usize {
    size.lines
}

struct Chunk {
    entries: Vec<Entry>,
    size: Size,
}

impl Chunk {
    fn new(entries: Vec<Entry>) -> Self {
        let size = entries
            .iter()
            .fold(Size::default(), |sum, e| sum.plus(e.size));
        Self { entries, size }
    }
}

pub(crate) struct Store {
    chunks: Vec<Chunk>,
    /// Fenwick tree over chunk sizes, 1-based.
    tree: Vec<Size>,
}

impl Store {
    /// `entries` is never empty: a note has at least one line.
    pub fn new(entries: Vec<Entry>) -> Self {
        let mut store = Self {
            chunks: cut(entries),
            tree: Vec::new(),
        };
        store.build();
        store
    }

    fn build(&mut self) {
        let n = self.chunks.len();
        self.tree = vec![Size::default(); n + 1];
        for i in 1..=n {
            self.tree[i] = self.tree[i].plus(self.chunks[i - 1].size);
            let parent = i + i.isolate_lowest_one();
            if parent <= n {
                self.tree[parent] = self.tree[parent].plus(self.tree[i]);
            }
        }
    }

    /// Replace chunk `index`'s size in the tree.
    fn resize(&mut self, index: usize, old: Size) {
        let new = self.chunks[index].size;
        let mut i = index + 1;
        while i < self.tree.len() {
            self.tree[i] = self.tree[i].minus(old).plus(new);
            i += i.isolate_lowest_one();
        }
    }

    /// The sizes of the first `count` chunks.
    fn prefix(&self, count: usize) -> Size {
        let mut sum = Size::default();
        let mut i = count;
        while i > 0 {
            sum = sum.plus(self.tree[i]);
            i -= i.isolate_lowest_one();
        }
        sum
    }

    pub fn total(&self) -> Size {
        self.prefix(self.chunks.len())
    }

    pub fn len(&self) -> usize {
        self.total().lines
    }

    /// The first chunk whose end in `measure` is past `offset`, and the size
    /// of the chunks before it.
    fn chunk_past(&self, measure: Measure, offset: usize) -> Option<(usize, Size)> {
        let n = self.chunks.len();
        let mut at = 0;
        let mut before = Size::default();
        let mut step = n.next_power_of_two();
        while step > 0 {
            let next = at + step;
            if next <= n && measure(&before.plus(self.tree[next])) <= offset {
                at = next;
                before = before.plus(self.tree[next]);
            }
            step /= 2;
        }
        (at < n).then_some((at, before))
    }

    /// The first line whose end in `measure` is past `offset`, and the size
    /// of the lines before it. `None` when `offset` is at or past the end.
    pub fn line_past(&self, measure: Measure, offset: usize) -> Option<(usize, Size)> {
        let (chunk, mut before) = self.chunk_past(measure, offset)?;
        let first = before.lines;
        for (index, entry) in self.chunks[chunk].entries.iter().enumerate() {
            let after = before.plus(entry.size);
            if measure(&after) > offset {
                return Some((first + index, before));
            }
            before = after;
        }
        unreachable!("the chunk's size reaches past the offset")
    }

    /// The chunk holding line `index` and the line's place in it.
    fn place(&self, index: usize) -> (usize, usize) {
        let (chunk, before) = self
            .chunk_past(lines, index)
            .expect("line index within the note");
        (chunk, index - before.lines)
    }

    pub fn get(&self, index: usize) -> &Entry {
        let (chunk, at) = self.place(index);
        &self.chunks[chunk].entries[at]
    }

    /// The size of the lines before line `index` (`index` may be the line count).
    pub fn before(&self, index: usize) -> Size {
        if index == self.len() {
            return self.total();
        }
        let (chunk, at) = self.place(index);
        self.chunks[chunk].entries[..at]
            .iter()
            .fold(self.prefix(chunk), |sum, e| sum.plus(e.size))
    }

    /// Change line `index` in place; `change` keeps the entry's size current.
    pub fn update(&mut self, index: usize, change: impl FnOnce(&mut Entry)) {
        let (chunk, at) = self.place(index);
        let old = self.chunks[chunk].size;
        let entry = &mut self.chunks[chunk].entries[at];
        let before = entry.size;
        change(entry);
        let after = entry.size;
        self.chunks[chunk].size = old.minus(before).plus(after);
        self.resize(chunk, old);
    }

    /// Lines from `index` on.
    pub fn iter_from(&self, index: usize) -> impl Iterator<Item = &Entry> {
        let (chunk, at) = if index >= self.len() {
            (self.chunks.len(), 0)
        } else {
            self.place(index)
        };
        self.chunks[chunk.min(self.chunks.len())..]
            .iter()
            .enumerate()
            .flat_map(move |(i, c)| c.entries[if i == 0 { at } else { 0 }..].iter())
    }

    /// Replace lines `range` with `new`, returning the lines taken out. The
    /// note keeps at least one line.
    pub fn splice(&mut self, range: Range<usize>, new: Vec<Entry>) -> Vec<Entry> {
        let len = self.len();
        debug_assert!(range.start <= range.end && range.end <= len);
        debug_assert!(len - range.len() + new.len() > 0);
        let (first, start) = if range.start == len {
            let last = self.chunks.len() - 1;
            (last, self.chunks[last].entries.len())
        } else {
            self.place(range.start)
        };
        let (last, end) = if range.is_empty() {
            (first, start)
        } else {
            let (chunk, at) = self.place(range.end - 1);
            (chunk, at + 1)
        };
        if first == last {
            let count = self.chunks[first].entries.len() - (end - start) + new.len();
            if (1..=MAX).contains(&count) {
                let old = self.chunks[first].size;
                let chunk = &mut self.chunks[first];
                let taken: Vec<Entry> = chunk.entries.splice(start..end, new).collect();
                *chunk = Chunk::new(std::mem::take(&mut chunk.entries));
                self.resize(first, old);
                return taken;
            }
        }
        // Rebuild the chunks the range touches, and the next one when the
        // result would be short.
        let end = end
            + self.chunks[first..last]
                .iter()
                .map(|c| c.entries.len())
                .sum::<usize>();
        let mut entries: Vec<Entry> = Vec::new();
        for chunk in &mut self.chunks[first..=last] {
            entries.append(&mut chunk.entries);
        }
        let taken: Vec<Entry> = entries.splice(start..end, new).collect();
        let mut through = last;
        if entries.len() < MIN && through + 1 < self.chunks.len() {
            through += 1;
            entries.append(&mut self.chunks[through].entries);
        }
        let rebuilt = if entries.is_empty() {
            Vec::new()
        } else {
            cut(entries)
        };
        self.chunks.splice(first..=through, rebuilt);
        if self.chunks.is_empty() {
            self.chunks.push(Chunk::new(Vec::new()));
        }
        self.build();
        taken
    }
}

/// Cut `entries` into chunks of about [`TARGET`] lines.
fn cut(entries: Vec<Entry>) -> Vec<Chunk> {
    let count = entries.len().div_ceil(TARGET).max(1);
    let per = entries.len().div_ceil(count).max(1);
    let mut chunks = Vec::with_capacity(count);
    let mut rest = entries.into_iter().peekable();
    while rest.peek().is_some() {
        chunks.push(Chunk::new(rest.by_ref().take(per).collect()));
    }
    if chunks.is_empty() {
        chunks.push(Chunk::new(Vec::new()));
    }
    chunks
}
