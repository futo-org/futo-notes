//! A draft of line rewrites: the lines a list command changes, read again as
//! they will be, so later steps of the same command (renumbering after an
//! indent) see them. `finish` turns the draft into one `Command`.
use super::super::super::command::{Command, Edit};
use super::super::super::Engine;
use super::{parts, Parts};
use crate::lines::{block, Line};
use std::collections::BTreeMap;
use std::ops::Range;

/// One rewritten line. The text before `cut` (in the old line) became the
/// text before `new_cut`; the rest is the old text, with one `\` inserted
/// at `escape` (relative to the cut) when a command had to write one.
struct Rewrite {
    body: String,
    line: Line,
    old_cut: usize,
    new_cut: usize,
    escape: Option<usize>,
}

pub(super) struct Draft<'a> {
    engine: &'a Engine,
    rewrites: BTreeMap<usize, Rewrite>,
}

impl<'a> Draft<'a> {
    pub fn new(engine: &'a Engine) -> Self {
        Self {
            engine,
            rewrites: BTreeMap::new(),
        }
    }

    pub fn count(&self) -> usize {
        self.engine.line_count()
    }

    /// Line `index` without its ending, as the draft has it.
    pub fn body(&self, index: usize) -> &str {
        match self.rewrites.get(&index) {
            Some(rewrite) => &rewrite.body,
            None => self.engine.line(index).body(),
        }
    }

    pub fn line(&self, index: usize) -> &Line {
        match self.rewrites.get(&index) {
            Some(rewrite) => &rewrite.line,
            None => &self.engine.line(index).line,
        }
    }

    pub fn parts(&self, index: usize) -> Parts {
        parts(self.body(index), self.line(index))
    }

    /// Replace the text before `cut` (in the line as the draft has it) with
    /// `prefix`.
    pub fn set_prefix(&mut self, index: usize, prefix: &str, cut: usize) {
        let body = format!("{prefix}{}", &self.body(index)[cut..]);
        let (old_cut, escape) = match self.rewrites.get(&index) {
            // Text after the cut is the old text after the first cut.
            Some(rewrite) => (
                rewrite.old_cut + cut.saturating_sub(rewrite.new_cut),
                rewrite.escape,
            ),
            None => (cut, None),
        };
        self.store(index, body, old_cut, prefix.len(), escape);
    }

    /// Replace the line with `prefix` then the old text after `cut`, where
    /// `written` is that text as `kept_line` wrote it (with at most one `\`
    /// added).
    pub fn set_kept(&mut self, index: usize, written: String, prefix: usize, cut: usize) {
        debug_assert!(!self.rewrites.contains_key(&index));
        let old = &self.engine.line(index).body()[cut..];
        let new = &written[prefix..];
        let escape = (new.len() != old.len()).then(|| {
            old.bytes()
                .zip(new.bytes())
                .position(|(a, b)| a != b)
                .unwrap_or(old.len())
        });
        self.store(index, written, cut, prefix, escape);
    }

    fn store(
        &mut self,
        index: usize,
        body: String,
        old_cut: usize,
        new_cut: usize,
        escape: Option<usize>,
    ) {
        let entry = self.engine.line(index);
        let mut carry = entry.carry.clone();
        carry.first = false;
        let text = format!("{body}{}", entry.ending());
        let line = block::read_line(&mut carry, &text, 0);
        self.rewrites.insert(
            index,
            Rewrite {
                body,
                line,
                old_cut,
                new_cut,
                escape,
            },
        );
    }

    pub fn is_empty(&self) -> bool {
        self.rewrites
            .iter()
            .all(|(index, rewrite)| rewrite.body == self.engine.line(*index).body())
    }

    /// Where source offset `at` (before the command) lands after it. A
    /// position in a rewritten line's prefix lands where its text starts.
    pub fn map(&self, at: usize) -> usize {
        let index = self.engine.line_of(at);
        let start = self.engine.line_start(index);
        let shift: isize = self
            .rewrites
            .range(..index)
            .map(|(line, rewrite)| {
                rewrite.body.len() as isize - self.engine.line(*line).body_len() as isize
            })
            .sum();
        let local = at - start;
        let local = match self.rewrites.get(&index) {
            None => local,
            Some(rewrite) => {
                let old_len = self.engine.line(index).body_len();
                if local > old_len {
                    rewrite.body.len() + local - old_len
                } else if local <= rewrite.old_cut {
                    rewrite.new_cut
                } else {
                    let into = local - rewrite.old_cut;
                    rewrite.new_cut + into + usize::from(rewrite.escape.is_some_and(|k| into > k))
                }
            }
        };
        (start as isize + shift) as usize + local
    }

    /// The command: `main` (an edit of the lines it names, all above every
    /// rewritten line) and each rewritten line's edit, leaving `selection`
    /// (source offsets after the command). `None` when nothing changes.
    pub fn finish(
        self,
        main: Option<(Edit, Range<usize>)>,
        selection: Range<usize>,
    ) -> Option<Command> {
        let mut edits = Vec::new();
        let mut lines: Vec<Range<usize>> = Vec::new();
        if let Some((edit, named)) = main {
            edits.push(edit);
            lines.push(named);
        }
        for (index, rewrite) in &self.rewrites {
            let old = self.engine.line(*index).body();
            if let Some(edit) = diff(self.engine.line_start(*index), old, &rewrite.body) {
                edits.push(edit);
                match lines.last_mut() {
                    Some(last) if last.end == *index => last.end += 1,
                    _ => lines.push(*index..*index + 1),
                }
            }
        }
        if edits.is_empty() {
            return None;
        }
        Some(Command {
            edits,
            lines,
            selection,
            affinity: None,
            typed: false,
        })
    }
}

/// The edit turning `old` (at source offset `start`) into `new`, without
/// the bytes both share at either end.
pub(super) fn diff(start: usize, old: &str, new: &str) -> Option<Edit> {
    if old == new {
        return None;
    }
    let mut head = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(head) {
        head -= 1;
    }
    let room = old.len().min(new.len()) - head;
    let mut tail = old
        .bytes()
        .rev()
        .zip(new.bytes().rev())
        .take(room)
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(old.len() - tail) || !new.is_char_boundary(new.len() - tail) {
        tail -= 1;
    }
    Some(Edit::new(
        start + head..start + old.len() - tail,
        &new[head..new.len() - tail],
    ))
}
