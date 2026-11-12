//! Indent and Outdent. A line's indent is its own leading whitespace (a
//! space is one column, a tab four); there is no depth. Indent writes one
//! tab after the line's quote markers. Outdent gives the line the leading
//! whitespace of the item it sits under (the nearest item above with less
//! indent, past blank lines and lines indented further), so it lines up
//! with that item; with no such item it takes off one tab, or every space.
//! The lines under the item (lines indented further, down to the first
//! that is not) move with it by the same whitespace.
use super::super::super::command::Command;
use super::super::super::Engine;
use super::draft::Draft;
use super::number::{ordinal, Level};
use crate::lines::block::width;
use crate::lines::{FenceRole, Kind};
use crate::{DisplayRange, EditorError};

impl Engine {
    /// Indent (or Outdent) every list item the range touches, with the
    /// lines under it.
    pub(super) fn indent_command(
        &self,
        range: DisplayRange,
        outdent: bool,
    ) -> Result<Option<Command>, EditorError> {
        let lines = self.lines_of(range);
        let mut draft = Draft::new(self);
        let mut index = lines.start;
        while index < lines.end {
            let Kind::List { indent, .. } = draft.line(index).kind else {
                index += 1;
                continue;
            };
            if outdent && indent == 0 {
                index += 1;
                continue;
            }
            let end = draft.under(index);
            if outdent {
                draft.outdent(index, end);
            } else {
                draft.indent(index, end);
            }
            index = end;
        }
        let selected = self.source_selection(range);
        let selection = draft.map(selected.start)..draft.map(selected.end);
        Ok(draft.finish(None, selection))
    }
}

impl Draft<'_> {
    /// The end (exclusive) of the lines under item `root`: lines indented
    /// further than it, and the code of a fence opened under it.
    pub fn under(&self, root: usize) -> usize {
        let level = Level::of(self.line(root));
        let mut index = root + 1;
        let mut fenced = false;
        while index < self.count() {
            let line = self.line(index);
            if fenced {
                if let Kind::Fence { role, .. } = line.kind {
                    fenced = role != FenceRole::Close;
                    index += 1;
                    continue;
                }
            }
            if line.quote != level.quote {
                break;
            }
            match line.kind {
                Kind::List { indent, .. } | Kind::Plain { indent } if indent > level.indent => {}
                Kind::Fence {
                    role: FenceRole::Open,
                    indent,
                    ..
                } if indent > level.indent => fenced = true,
                _ => break,
            }
            index += 1;
        }
        index
    }

    /// Indent `root..end` by one tab; a numbered root renumbers.
    fn indent(&mut self, root: usize, end: usize) {
        let before = self.line(root).clone();
        let number = ordinal(self.body(root), &before);
        for index in root..end {
            let body = self.body(index);
            let code = matches!(
                self.line(index).kind,
                Kind::Fence {
                    role: FenceRole::Code,
                    ..
                }
            );
            if code && body.is_empty() {
                continue;
            }
            let part = self.parts(index);
            let prefix = format!(
                "{}\t{}",
                &body[..part.quote],
                &body[part.quote..part.content]
            );
            self.set_prefix(index, &prefix, part.content);
        }
        let Some((was, delimiter)) = number else {
            return;
        };
        let old = Level::of(&before);
        let new = Level::of(self.line(root));
        // A new sub-list counts from 1; under a numbered sibling it counts on.
        let above = self
            .number_above(root, new)
            .filter(|&(_, _, d)| d == delimiter);
        let now = above.map_or(1, |(_, n, _)| n + 1);
        self.set_number(root, now);
        // The items it left close up.
        self.bump(end, old, delimiter, was, was - 1);
        if let Some((_, n, _)) = above {
            self.bump(end, new, delimiter, n, now);
        }
    }

    /// Outdent `root..end` to the whitespace of the item `root` sits under;
    /// a numbered root renumbers.
    fn outdent(&mut self, root: usize, end: usize) {
        let before = self.line(root).clone();
        let number = ordinal(self.body(root), &before);
        let old = Level::of(&before);
        let part = self.parts(root);
        let old_space = self.body(root)[part.quote..part.space].to_owned();
        let new_space = self.space_above(root, old).unwrap_or_else(|| {
            if old_space.contains('\t') {
                old_space.replacen('\t', "", 1)
            } else {
                String::new()
            }
        });
        let dropped = width(&old_space) - width(&new_space);
        for index in root..end {
            let body = self.body(index);
            let part = self.parts(index);
            let space = &body[part.quote..part.space];
            let fence = matches!(self.line(index).kind, Kind::Fence { .. });
            let written = if index == root {
                new_space.clone()
            } else if let Some(rest) = space.strip_prefix(old_space.as_str()) {
                format!("{new_space}{rest}")
            } else if fence {
                // Code keeps whitespace it does not share with the item.
                continue;
            } else {
                let keep = width(space).saturating_sub(dropped + width(&new_space));
                format!("{new_space}{}", " ".repeat(keep))
            };
            let prefix = format!(
                "{}{written}{}",
                &body[..part.quote],
                &body[part.space..part.content]
            );
            self.set_prefix(index, &prefix, part.content);
        }
        let Some((was, delimiter)) = number else {
            return;
        };
        let new = Level::of(self.line(root));
        // The items it left now sit under it: they count again from 1.
        self.bump(end, old, delimiter, was, 0);
        // Under a numbered sibling it counts on, and so do the items after.
        if let Some((_, n, _)) = self
            .number_above(root, new)
            .filter(|&(_, _, d)| d == delimiter)
        {
            self.set_number(root, n + 1);
            self.bump(end, new, delimiter, n, n + 1);
        }
    }

    /// The leading whitespace of the item line `index` (at `level`) sits
    /// under: the nearest item above with less indent, past blank lines and
    /// lines indented further.
    fn space_above(&self, index: usize, level: Level) -> Option<String> {
        for above in (0..index).rev() {
            let line = self.line(above);
            if line.quote != level.quote {
                return None;
            }
            match line.kind {
                Kind::List { indent, .. } if indent < level.indent => {
                    let part = self.parts(above);
                    return Some(self.body(above)[part.quote..part.space].to_owned());
                }
                Kind::Blank | Kind::List { .. } => {}
                Kind::Plain { indent } if indent > 0 => {}
                Kind::Fence {
                    role: FenceRole::Code | FenceRole::Close,
                    ..
                } => {}
                Kind::Fence {
                    role: FenceRole::Open,
                    indent,
                    ..
                } if indent > 0 => {}
                _ => return None,
            }
        }
        None
    }
}
