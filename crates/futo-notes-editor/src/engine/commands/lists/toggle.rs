//! The toolbar's Bullet, Numbered and Task buttons, and the checkbox toggle,
//! over every line the selection touches.
use super::super::super::command::{kept_line, Command};
use super::super::super::Engine;
use super::draft::Draft;
use super::number::{spell, Level};
use super::{lifted, parts};
use crate::lines::block::width;
use crate::lines::{Kind, Line};
use crate::{DisplayRange, EditorError};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Target {
    Bullet,
    Ordered,
    Task,
}

impl Target {
    /// Whether `line` is already this kind of item.
    fn holds(self, line: &Line) -> bool {
        let Kind::List { ordered, task, .. } = line.kind else {
            return false;
        };
        match self {
            Target::Bullet => !ordered && task.is_none(),
            Target::Ordered => ordered,
            Target::Task => task.is_some(),
        }
    }
}

impl Engine {
    /// A list button on the lines the range touches. When every plain line,
    /// heading and item among them is already this kind of item, their
    /// markers come off. Otherwise each that is not becomes one, keeping its
    /// quotes, indent and text (a heading loses its `#`s); a numbered item
    /// counts on from the numbered item above it at its indent, or from 1.
    /// A caret on a blank line starts an empty item there; in a wider
    /// selection blank lines stay blank. Fences, tables, dividers and front
    /// matter are left as they are.
    pub(super) fn toggle_list(
        &self,
        range: DisplayRange,
        target: Target,
    ) -> Result<Option<Command>, EditorError> {
        let lines = self.lines_of(range);
        let blank_caret =
            range.start == range.end && matches!(self.line(lines.start).line.kind, Kind::Blank);
        let chosen: Vec<usize> = lines
            .filter(|&index| match self.line(index).line.kind {
                Kind::Plain { .. } | Kind::Heading { .. } | Kind::List { .. } => true,
                Kind::Blank => blank_caret,
                _ => false,
            })
            .collect();
        if chosen.is_empty() {
            return Ok(None);
        }
        let mut draft = Draft::new(self);
        let lift = !blank_caret
            && chosen
                .iter()
                .all(|&index| target.holds(&self.line(index).line));
        if lift {
            for &index in &chosen {
                let entry = self.line(index);
                let (written, prefix, cut) = lifted(entry.body(), &entry.line, &entry.carry);
                draft.set_kept(index, written, prefix, cut);
            }
        } else {
            self.make_items(&mut draft, &chosen, target);
        }
        let selected = self.source_selection(range);
        let selection = draft.map(selected.start)..draft.map(selected.end);
        Ok(draft.finish(None, selection))
    }

    fn make_items(&self, draft: &mut Draft, chosen: &[usize], target: Target) {
        // For each numbered item written: the number its run counted from
        // before the command, so the items below can be bumped.
        let mut origins: HashMap<usize, i128> = HashMap::new();
        let mut last = None;
        for &index in chosen {
            if target.holds(draft.line(index)) {
                continue;
            }
            let entry = self.line(index);
            let body = entry.body();
            let part = parts(body, &entry.line);
            let space = &body[part.quote..part.space];
            let level = Level {
                quote: entry.line.quote,
                indent: width(space),
            };
            let (bullet, gap) = match entry.line.kind {
                Kind::List { ordered, .. } => (
                    if ordered {
                        "-"
                    } else {
                        &body[part.marker.clone()]
                    },
                    &body[part.marker.end..part.marker.end + 1],
                ),
                _ => ("-", " "),
            };
            let marker = match target {
                Target::Bullet => format!("{bullet}{gap}"),
                Target::Task => format!("{bullet}{gap}[ ] "),
                Target::Ordered => {
                    let above = draft.number_above(index, level);
                    let (number, delimiter, origin) = match above {
                        Some((at, n, d)) => (n + 1, d, origins.get(&at).copied().unwrap_or(n)),
                        None => (1, b'.', 0),
                    };
                    origins.insert(index, origin);
                    last = Some((index, level, delimiter, origin, number));
                    format!("{}{}{gap}", spell(number, ""), delimiter as char)
                }
            };
            let prefix = format!("{}{marker}", &body[..part.space]);
            let quote = entry.line.quote;
            let written = kept_line(&entry.carry, &prefix, &body[part.content..], |read| {
                target.holds(read) && read.quote == quote
            });
            draft.set_kept(index, written, prefix.len(), part.content);
        }
        if let Some((index, level, delimiter, origin, number)) = last {
            draft.bump(index + 1, level, delimiter, origin, number);
        }
    }

    /// The checkbox toggle on the task items the range touches: when any is
    /// unchecked all are checked, else all are unchecked.
    pub(super) fn toggle_task(&self, range: DisplayRange) -> Result<Option<Command>, EditorError> {
        let tasks: Vec<(usize, bool)> = self
            .lines_of(range)
            .filter_map(|index| match self.line(index).line.kind {
                Kind::List {
                    task: Some(checked),
                    ..
                } => Some((index, checked)),
                _ => None,
            })
            .collect();
        if tasks.is_empty() {
            return Ok(None);
        }
        let check = tasks.iter().any(|&(_, checked)| !checked);
        let mut draft = Draft::new(self);
        for (index, checked) in tasks {
            if checked == check {
                continue;
            }
            let body = self.line(index).body();
            let content = draft.parts(index).content;
            // The box is `[`, its state, `]` and a space before the text.
            let prefix = format!(
                "{}{}{}",
                &body[..content - 3],
                if check { "x" } else { " " },
                &body[content - 2..content]
            );
            draft.set_prefix(index, &prefix, content);
        }
        let selected = self.source_selection(range);
        let selection = draft.map(selected.start)..draft.map(selected.end);
        Ok(draft.finish(None, selection))
    }
}
