//! Fenced code: the code block commands, and the keys inside a fence
//! (`keys.rs`).
//!
//! Code text is the line's text, whitespace and all: nothing inside a fence
//! is Markdown. Putting lines in a fence keeps their text exactly; taking
//! lines out of a fence keeps each one a plain line (`kept_line` writes a
//! leading `\` where the text would read as another block), so the shown
//! text does not move.
mod cut;
mod keys;

use super::super::command::{kept_line, Command, Edit};
use super::super::line::Role;
use super::super::Engine;
use crate::lines::{block, FenceRole, Kind};
use crate::{BlockCommand, DisplayRange, EditorError};
use std::ops::Range;

/// A fence's lines: its opening line, and the line after its code (the
/// closing line, or the note's line count when nothing closes it).
#[derive(Clone, Copy, Debug)]
pub(super) struct Fence {
    pub open: usize,
    pub end: usize,
    pub closed: bool,
}

impl Fence {
    pub(super) fn code(&self) -> Range<usize> {
        self.open + 1..self.end
    }

    /// The fence's last line.
    pub(super) fn last(&self) -> usize {
        if self.closed {
            self.end
        } else {
            self.end - 1
        }
    }
}

/// What a range touches inside fences.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Touch {
    /// Code lines of one fence.
    Code(Range<usize>),
    /// The one empty line of a fence with no code line (its opening line).
    Empty(usize),
}

/// A line of new text: where its text came from (the old line, and the
/// column a `\` was written before), its text and its ending.
struct Piece {
    from: Option<(usize, Option<usize>)>,
    text: String,
    ending: String,
}

impl Piece {
    fn new(text: impl Into<String>, ending: impl Into<String>) -> Self {
        Self {
            from: None,
            text: text.into(),
            ending: ending.into(),
        }
    }
}

fn fence_role(kind: &Kind) -> Option<FenceRole> {
    match kind {
        Kind::Fence { role, .. } => Some(*role),
        _ => None,
    }
}

/// Leading spaces and tabs.
fn leading(text: &str) -> &str {
    &text[..text.len() - text.trim_start_matches([' ', '\t']).len()]
}

/// The run of backticks a line of only backticks has (after its indent and
/// before trailing whitespace), else 0: a fence must be longer.
fn backtick_run(text: &str) -> usize {
    let own = text.trim_matches([' ', '\t']);
    if !own.is_empty() && own.bytes().all(|b| b == b'`') {
        own.len()
    } else {
        0
    }
}

impl Engine {
    fn role(&self, index: usize) -> Option<FenceRole> {
        fence_role(&self.line(index).line.kind)
    }

    fn is_code(&self, index: usize) -> bool {
        self.role(index) == Some(FenceRole::Code)
    }

    /// The fence holding line `index` (an opening, code or closing line).
    pub(super) fn fence_around(&self, index: usize) -> Option<Fence> {
        let mut open = index;
        match self.role(index)? {
            FenceRole::Open => {}
            FenceRole::Code | FenceRole::Close => {
                open -= 1;
                while self.is_code(open) {
                    open -= 1;
                }
            }
        }
        let count = self.line_count();
        let mut end = open + 1;
        while end < count && self.is_code(end) {
            end += 1;
        }
        let closed = end < count && self.role(end) == Some(FenceRole::Close);
        Some(Fence { open, end, closed })
    }

    /// The fence lines display `range` touches, when it touches only code
    /// lines of one fence, or only an empty code block's line.
    pub(super) fn touch(&self, range: DisplayRange) -> Option<Touch> {
        let lines = self.lines_of(range);
        let first = self.line(lines.start);
        if lines.len() == 1
            && first.view.role == Role::Empty
            && fence_role(&first.line.kind) == Some(FenceRole::Open)
        {
            return Some(Touch::Empty(lines.start));
        }
        lines
            .clone()
            .all(|index| self.is_code(index))
            .then_some(Touch::Code(lines))
    }

    /// The text of a closing line for the fence opened on line `open`: the
    /// closing line's own when it has one, else the opening line's indent
    /// and fence characters.
    fn closing_text(&self, fence: Fence) -> String {
        if fence.closed {
            return self.line(fence.end).body().to_owned();
        }
        let body = self.line(fence.open).body();
        let indent = leading(body);
        let rest = &body[indent.len()..];
        let ch = rest.as_bytes()[0];
        let run = rest.bytes().take_while(|&b| b == ch).count();
        format!("{indent}{}", &rest[..run])
    }

    /// The line ending new lines next to line `index` take.
    fn new_ending(&self, index: usize) -> String {
        self.empty_line_ending(index)
    }

    /// The command that writes `pieces` over lines `lines` (with their
    /// endings) and selects old source `selection` where its text went.
    fn rewrite(&self, lines: Range<usize>, pieces: &[Piece], selection: Range<usize>) -> Command {
        let start = self.line_start(lines.start);
        let end = self.line_start(lines.end - 1) + self.line(lines.end - 1).text.len();
        let mut text = String::new();
        let mut placed: Vec<(usize, usize, Option<usize>, usize)> = Vec::new();
        for piece in pieces {
            if let Some((line, escape)) = piece.from {
                placed.push((line, start + text.len(), escape, piece.text.len()));
            }
            text.push_str(&piece.text);
            text.push_str(&piece.ending);
        }
        let map = |at: usize| {
            let line = self.line_of(at);
            let column = at - self.line_start(line);
            match placed.iter().find(|(old, ..)| *old >= line) {
                Some(&(old, new, escape, len)) if old == line => {
                    new + len.min(column + usize::from(escape.is_some_and(|e| column > e)))
                }
                Some(&(_, new, ..)) => new,
                None => start + text.len(),
            }
        };
        let selection = map(selection.start)..map(selection.end);
        // Only the bytes that change.
        let old = self.source_slice(start..end);
        let mut prefix = old
            .bytes()
            .zip(text.bytes())
            .take_while(|(a, b)| a == b)
            .count();
        while !old.is_char_boundary(prefix) || !text.is_char_boundary(prefix) {
            prefix -= 1;
        }
        let mut suffix = old[prefix..]
            .bytes()
            .rev()
            .zip(text[prefix..].bytes().rev())
            .take_while(|(a, b)| a == b)
            .count();
        while !old.is_char_boundary(old.len() - suffix)
            || !text.is_char_boundary(text.len() - suffix)
        {
            suffix -= 1;
        }
        let edit = Edit::new(
            start + prefix..end - suffix,
            &text[prefix..text.len() - suffix],
        );
        Command::new(vec![edit], lines, selection)
    }

    /// Code block toolbar commands. Both turn the lines a range touches into
    /// one code block, and take them out of code when they are all code of
    /// one block.
    pub(super) fn fence_command(
        &self,
        range: DisplayRange,
        _command: BlockCommand,
    ) -> Result<Option<Command>, EditorError> {
        let selection = self.source_selection(range);
        Ok(match self.touch(range) {
            Some(touch) => Some(self.code_off(touch, selection)),
            None => self.code_on(self.lines_of(range), selection),
        })
    }

    /// Take the touched code lines out of their fence: the code above and
    /// below them keeps a fence of its own (the opening line's spelling),
    /// and each line taken out stays a plain line.
    fn code_off(&self, touch: Touch, selection: Range<usize>) -> Command {
        let (fence, taken) = match touch {
            Touch::Code(lines) => (self.fence_around(lines.start).expect("code"), lines),
            Touch::Empty(open) => (
                self.fence_around(open).expect("a fence"),
                open + 1..open + 1,
            ),
        };
        let named = fence.open..fence.last() + 1;
        let last_ending = self.line(fence.last()).ending().to_owned();
        if fence.code().is_empty() {
            // An empty block's one empty line stays, as an empty line.
            let mut piece = Piece::new("", last_ending);
            piece.from = Some((fence.open, None));
            return self.rewrite(named, &[piece], selection);
        }
        let opening = self.line(fence.open).body().to_owned();
        let ending = self.line(fence.open).ending().to_owned();
        let verbatim = |index: usize| {
            let entry = self.line(index);
            Piece {
                from: Some((index, None)),
                text: entry.body().to_owned(),
                ending: entry.ending().to_owned(),
            }
        };
        let mut pieces = Vec::new();
        let mut carry = self.line(fence.open).carry.clone();
        carry.fence = None;
        if taken.start > fence.open + 1 {
            pieces.push(verbatim(fence.open));
            pieces.extend((fence.open + 1..taken.start).map(verbatim));
            pieces.push(Piece::new(self.closing_text(fence), ending.clone()));
            carry.first = false;
            carry.header_above = None;
        }
        for index in taken.clone() {
            let entry = self.line(index);
            let plain = |line: &crate::lines::Line| {
                matches!(line.kind, Kind::Plain { .. } | Kind::Blank) && line.quote == 0
            };
            let text = kept_line(&carry, "", entry.body(), plain);
            let escape = (text.len() > entry.body().len()).then(|| {
                text.bytes()
                    .zip(entry.body().bytes())
                    .take_while(|(a, b)| a == b)
                    .count()
            });
            block::read_line(&mut carry, &format!("{text}\n"), 0);
            pieces.push(Piece {
                from: Some((index, escape)),
                text,
                ending: entry.ending().to_owned(),
            });
        }
        if taken.end < fence.end {
            pieces.push(Piece::new(opening, ending));
            pieces.extend((taken.end..fence.end).map(verbatim));
            if fence.closed {
                pieces.push(verbatim(fence.end));
            }
        }
        pieces.last_mut().expect("a line").ending = last_ending;
        self.rewrite(named, &pieces, selection)
    }

    /// Put lines `lines` in one code block, their text exactly as it is. A
    /// fence they cut into is taken in whole, without its fence lines (its
    /// code joins the new block); the new fence is longer than any line of
    /// only backticks inside it.
    fn code_on(&self, lines: Range<usize>, selection: Range<usize>) -> Option<Command> {
        let mut first = lines.start;
        let mut last = lines.end - 1;
        if matches!(self.role(first), Some(FenceRole::Code | FenceRole::Close)) {
            first = self.fence_around(first)?.open;
        }
        if matches!(self.role(last), Some(FenceRole::Open | FenceRole::Code)) {
            last = self.fence_around(last)?.last();
        }
        let mut body = Vec::new();
        for index in first..=last {
            let entry = self.line(index);
            match &entry.line.kind {
                Kind::FrontMatter(_) => return None,
                Kind::Fence {
                    role: FenceRole::Open,
                    ..
                } if entry.view.role == Role::Empty => {}
                Kind::Fence {
                    role: FenceRole::Open | FenceRole::Close,
                    ..
                } => continue,
                _ => {}
            }
            let text = if entry.view.role == Role::Empty {
                ""
            } else {
                entry.body()
            };
            body.push(Piece {
                from: Some((index, None)),
                text: text.to_owned(),
                ending: entry.ending().to_owned(),
            });
        }
        let ending = self.new_ending(first);
        let run = body
            .iter()
            .map(|piece| backtick_run(&piece.text))
            .max()
            .unwrap_or(0);
        let fence = "`".repeat((run + 1).max(3));
        let last_ending = self.line(last).ending().to_owned();
        let mut pieces = vec![Piece::new(fence.clone(), ending.clone())];
        if body.is_empty() {
            body.push(Piece::new("", ""));
        }
        body.last_mut().expect("a line").ending = ending;
        pieces.extend(body);
        pieces.push(Piece::new(fence, last_ending));
        Some(self.rewrite(first..last + 1, &pieces, selection))
    }
}
