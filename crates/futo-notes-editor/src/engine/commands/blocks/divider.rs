//! The divider command.
use super::super::super::command::Command;
use super::super::super::line::Role;
use super::super::super::Engine;
use super::{right_side, spaced, split, Joined};
use crate::lines::{FrontMatterRole, Kind};
use crate::DisplayRange;

impl Engine {
    /// Put a divider at the caret, the selection removed first. Text before
    /// the caret stays on its line above the divider; text after it goes to
    /// a plain line below at the same quote depth, where the caret lands
    /// (on a blank line, the spaces and tabs after the caret go there).
    /// With no text after it, the caret lands on a new empty line below (in
    /// the line's quote). A divider is never quoted: it sits at column 0
    /// between the quoted lines. Nothing is written in code, front matter
    /// or a table.
    pub(super) fn divider(&self, range: DisplayRange) -> Option<Command> {
        let (joined, after_front_matter) = self.placed(range)?;
        let (out, caret) = self.divider_text(&joined, after_front_matter);
        Some(self.rejoin(&joined, &out, caret))
    }

    /// The text Divider writes over the joined lines, and the caret in it.
    fn divider_text(&self, joined: &Joined, after_front_matter: bool) -> (String, usize) {
        let text = joined.text.as_str();
        let line = &joined.line;
        let ending = self.empty_line_ending(joined.first);
        let quote = joined.quote();
        let (left, right, caret) = if line.kind == Kind::Divider || after_front_matter {
            let below = spaced(quote);
            let caret = below.len();
            (Some(text.to_owned()), below, caret)
        } else {
            let (at, closes, opens) = split(text, line, &joined.spans, joined.caret);
            if line.kind == Kind::Blank {
                let below = spaced(quote);
                let caret = below.len();
                let rest = &text[joined.caret.max(quote.len())..];
                (None, format!("{below}{rest}"), caret)
            } else if at <= line.content.start {
                (None, text.to_owned(), joined.caret.max(line.content.start))
            } else {
                let (right, caret) =
                    right_side(&joined.carry, quote, line.quote, &opens, &text[at..]);
                let caret = caret + joined.caret.saturating_sub(at);
                (Some(format!("{}{closes}", &text[..at])), right, caret)
            }
        };
        let mark = self.divider_mark(left.is_none() && joined.first == 0, joined.last);
        let mut out = String::new();
        if let Some(left) = &left {
            out.push_str(left);
            out.push_str(&ending);
        }
        out.push_str(mark);
        out.push_str(&ending);
        let caret = out.len() + caret;
        out.push_str(&right);
        (out, caret)
    }

    /// Whether Divider and Table act on display `range`. Table writes its
    /// rows wherever it is `placed`; Divider there writes its text over the
    /// joined lines, which over a selection can be the bytes it removes.
    pub(in crate::engine) fn divider_and_table_act(&self, range: DisplayRange) -> (bool, bool) {
        let Some((joined, after_front_matter)) = self.placed(range) else {
            return (false, false);
        };
        let (out, _) = self.divider_text(&joined, after_front_matter);
        let start = self.line_start(joined.first);
        let end = self.line_start(joined.last) + self.line(joined.last).body_len();
        let divider = out.len() != end - start || out != self.source_slice(start..end);
        (divider, true)
    }

    /// The line a divider or table goes on (`joined`), unless it is in code,
    /// front matter or a table; and whether it is the empty line front matter
    /// closed on the note's last line shows for the body, which the block
    /// goes after.
    pub(super) fn placed(&self, range: DisplayRange) -> Option<(Joined, bool)> {
        let joined = self.joined(range)?;
        let after_front_matter = joined.first == joined.last
            && joined.line.kind == Kind::FrontMatter(FrontMatterRole::Close)
            && self.line(joined.first).view.role == Role::Empty;
        let blocked = |kind: &Kind| {
            matches!(
                kind,
                Kind::Fence { .. } | Kind::FrontMatter(_) | Kind::Table { .. }
            )
        };
        if !after_front_matter
            && ((joined.first..=joined.last).any(|index| blocked(&self.line(index).line.kind))
                || blocked(&joined.line.kind))
        {
            return None;
        }
        Some((joined, after_front_matter))
    }

    /// `---`, unless a `---` there would make line 1 open front matter (a
    /// `---` on line 1 with another `---` below it): then `----`, which is a
    /// divider and closes nothing. `first` says the divider goes on line 1;
    /// `last` is the last line the command replaces.
    fn divider_mark(&self, first: bool, last: usize) -> &'static str {
        let closes = if first {
            (last + 1..self.line_count()).any(|index| self.line(index).body() == "---")
        } else {
            let top = self.line(0);
            top.line.kind == Kind::Divider && top.body() == "---"
        };
        if closes {
            "----"
        } else {
            "---"
        }
    }
}
