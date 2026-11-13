//! Enter and Backspace on heading and quote lines, and Enter on a plain
//! line inside inline marks.
use super::super::super::command::{Command, Edit};
use super::super::super::Engine;
use super::{as_heading, right_side, split, unquote, unquoted};
use crate::lines::{FenceRole, Kind, Line};
use crate::DisplayRange;

/// A heading, or a quoted line that is plain or empty (a quoted list item
/// is the list family's).
fn ours(line: &Line) -> bool {
    matches!(line.kind, Kind::Heading { .. })
        || line.quote > 0 && matches!(line.kind, Kind::Plain { .. } | Kind::Blank)
}

impl Engine {
    /// Enter on a heading or quoted line, the selection removed first. An
    /// empty quote line leaves one quote level. At the start of the line's
    /// text a line opens above it (quoted when the line above is) and the
    /// line keeps its block. Elsewhere the line splits: the text after the
    /// caret goes to a plain line at the same quote depth, and marks the
    /// caret is inside close before the break and open again after it.
    pub(super) fn block_enter(&self, range: DisplayRange) -> Option<Command> {
        let first = self.line_of(self.source_selection(range).start);
        if !ours(&self.line(first).line) {
            return None;
        }
        let joined = self.joined(range)?;
        let line = &joined.line;
        if !ours(line) {
            return None;
        }
        let text = &joined.text;
        if line.kind == Kind::Blank {
            let left = unquote(&joined.carry, text, line);
            return Some(self.rejoin(&joined, &left, left.len()));
        }
        let ending = self.empty_line_ending(joined.first);
        let quote = joined.quote();
        let (at, closes, opens) = split(text, line, &joined.spans, joined.caret);
        if at == line.content.start && at < text.len() {
            let above = if joined.first > 0 && self.line(joined.first - 1).line.quote > 0 {
                quote
            } else {
                ""
            };
            let out = format!("{above}{ending}{text}");
            return Some(self.rejoin(&joined, &out, above.len() + ending.len() + joined.caret));
        }
        let (right, caret) = right_side(&joined.carry, quote, line.quote, &opens, &text[at..]);
        // A caret after marks that open at the split stays after them.
        let caret = caret + joined.caret.saturating_sub(at);
        let left = format!("{}{closes}{ending}", &text[..at]);
        Some(self.rejoin(&joined, &format!("{left}{right}"), left.len() + caret))
    }

    /// Enter on an unquoted plain line, the selection removed first, where
    /// the caret is inside a mark's text or at its edge: the line splits as
    /// a quoted line does, the marks the caret is inside closing before the
    /// break and opening again after it (`**bo|ld**` gives `**bo**` and
    /// `**ld**`); at a mark's text start the break goes before the mark, at
    /// its text end after it. Anywhere else Enter types its line break.
    pub(super) fn plain_enter(&self, range: DisplayRange) -> Option<Command> {
        let plain = |line: &Line| matches!(line.kind, Kind::Plain { .. }) && line.quote == 0;
        let first = self.line_of(self.source_selection(range).start);
        if !plain(&self.line(first).line) {
            return None;
        }
        let joined = self.joined(range)?;
        let line = &joined.line;
        if !plain(line) {
            return None;
        }
        let text = &joined.text;
        let (at, closes, opens) = split(text, line, &joined.spans, joined.caret);
        if at == joined.caret && opens.is_empty() {
            return None;
        }
        let ending = self.empty_line_ending(joined.first);
        let (right, caret) = right_side(&joined.carry, "", 0, &opens, &text[at..]);
        // A caret after marks that open at the split stays after them.
        let caret = caret + joined.caret.saturating_sub(at);
        let left = format!("{}{closes}{ending}", &text[..at]);
        Some(self.rejoin(&joined, &format!("{left}{right}"), left.len() + caret))
    }

    /// Backspace from a caret at a heading's or quoted line's text start.
    ///
    /// A heading becomes text. With `joining` (iOS sends it for every
    /// caret Backspace) a heading instead joins the line above, as
    /// Backspace joins any line: an empty line above goes, text above takes
    /// the heading's text, and code above (behind its closing fence) takes
    /// it as code. A first line, or one under a divider, table or front
    /// matter, still becomes text.
    ///
    /// A quoted line under a quoted line of the same depth joins it (an
    /// empty one above goes instead); otherwise it leaves one quote level.
    pub(super) fn block_backspace(&self, range: DisplayRange, joining: bool) -> Option<Command> {
        if range.start != range.end {
            return None;
        }
        let at = self.source_selection(range).start;
        let index = self.line_of(at);
        let entry = self.line(index);
        let line = &entry.line;
        let start = self.line_start(index);
        if !ours(line) || range.start.0 != self.display_of(start + line.content.start) {
            return None;
        }
        let above = (index > 0).then(|| &self.line(index - 1).line);
        if let Kind::Heading { .. } = line.kind {
            if joining {
                if let Some(command) = self.join_heading(index) {
                    return Some(command);
                }
            }
            return self.retext(range, vec![(index, as_heading(entry, 0)?)]);
        }
        match above
            .filter(|above| above.quote == line.quote)
            .map(|a| &a.kind)
        {
            Some(Kind::Blank) => Some(self.drop_above(index, at)),
            Some(Kind::Plain { .. } | Kind::List { .. }) => Some(self.join_above(index)),
            _ => self.retext(range, vec![(index, unquoted(entry))]),
        }
    }

    /// Remove the line above `index`; the caret stays at `at`.
    fn drop_above(&self, index: usize, at: usize) -> Command {
        let above = self.line_start(index - 1);
        let start = self.line_start(index);
        let caret = at - (start - above);
        Command::new(
            vec![Edit::new(above..start, "")],
            index - 1..index + 1,
            caret..caret,
        )
    }

    /// Join line `index`'s text onto the end of the line above, dropping
    /// its markers and the line break.
    fn join_above(&self, index: usize) -> Command {
        let end = self.line_start(index - 1) + self.line(index - 1).body_len();
        let content = self.line_start(index) + self.line(index).line.content.start;
        Command::new(
            vec![Edit::new(end..content, "")],
            index - 1..index + 1,
            end..end,
        )
    }

    /// A heading joining the line above (see `block_backspace`), or `None`
    /// when it becomes text instead.
    fn join_heading(&self, index: usize) -> Option<Command> {
        let above = &self.line(index.checked_sub(1)?).line;
        match above.kind {
            Kind::Blank => {
                let at = self.line_start(index) + self.line(index).line.content.start;
                Some(self.drop_above(index, at))
            }
            Kind::Plain { .. } | Kind::Heading { .. } | Kind::List { .. } => {
                Some(self.join_above(index))
            }
            Kind::Fence {
                role: FenceRole::Close,
                ..
            } => Some(self.heading_into_code(index)),
            _ => None,
        }
    }

    /// A heading under a closing fence: its shown text lands at the end of
    /// the code's last line (an empty block gains one), and the heading line
    /// goes.
    fn heading_into_code(&self, index: usize) -> Command {
        let heading = self.line(index);
        let code = index - 2;
        let entry = self.line(code);
        let end = self.line_start(code) + entry.body_len();
        let mut text = heading.shown_body();
        if matches!(
            entry.line.kind,
            Kind::Fence {
                role: FenceRole::Open,
                ..
            }
        ) {
            text.insert_str(0, entry.ending());
        }
        let close_end = self.line_start(index - 1) + self.line(index - 1).body_len();
        let heading_end = self.line_start(index) + heading.body_len();
        let caret = end + text.len();
        Command::new(
            vec![
                Edit::insert(end, text),
                Edit::new(close_end..heading_end, ""),
            ],
            code..index + 1,
            caret..caret,
        )
    }
}
