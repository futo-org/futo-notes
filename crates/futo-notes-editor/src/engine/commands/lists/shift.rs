//! An item's lines moving with its whitespace: Indent, Outdent and a block
//! arriving in a list give an item new leading whitespace, and each line
//! under it swaps the item's old whitespace at its start for the new one.
use super::parts;
use crate::engine::line::Entry;
use crate::lines::block::width;
use crate::lines::{Kind, Line};

/// An item's leading whitespace before and after it moves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Shift {
    pub from: String,
    pub to: String,
}

impl Shift {
    /// The prefix line `body` (read as `line`, under the item) takes and
    /// where its old prefix ends; `None` when it keeps its bytes. A line
    /// that does not start with the item's whitespace keeps its columns
    /// past the item's; code keeps whitespace it does not share with it.
    pub(crate) fn under(&self, body: &str, line: &Line) -> Option<(String, usize)> {
        let part = parts(body, line);
        let space = &body[part.quote..part.space];
        let written = if let Some(rest) = space.strip_prefix(self.from.as_str()) {
            format!("{}{rest}", self.to)
        } else if matches!(line.kind, Kind::Fence { .. }) {
            return None;
        } else {
            let keep = width(space).saturating_sub(width(&self.from));
            format!("{}{}", self.to, " ".repeat(keep))
        };
        let prefix = format!(
            "{}{written}{}",
            &body[..part.quote],
            &body[part.space..part.content]
        );
        (prefix != body[..part.content]).then_some((prefix, part.content))
    }

    /// Line `entry`, under the item, with its ending, as the shift writes it.
    pub(crate) fn text(&self, entry: &Entry) -> String {
        match self.under(entry.body(), &entry.line) {
            Some((prefix, cut)) => format!("{prefix}{}", &entry.text[cut..]),
            None => entry.text.clone(),
        }
    }
}
