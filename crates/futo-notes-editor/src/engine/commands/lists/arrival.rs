//! What changes when a moved block arrives (#442). Strictly between two
//! lines of a list the block becomes a sibling of the item below the slot:
//! its first line takes that item's leading whitespace, its marker style (a
//! bullet character, or a number and delimiter) and its gap, and under a
//! task an unchecked box. A box the block already has stays with its state,
//! so among numbered items a task keeps its own bullet. A plain line, or a
//! photo lifted out of its line, becomes an item. When the line below the
//! slot is a line under an item rather than an item, the block takes that
//! line's whitespace and keeps its own marker (a plain line gets `- `).
//!
//! Outside any list an item goes to the left margin with its marker and box
//! as written, and an indented plain line loses its indent. In every case
//! the lines under an item move with its whitespace (`Shift`).
//!
//! The landing reads only the block's first line and the line below the
//! slot, so a slot's trial can afford it. The number it counts with, and
//! renumbering where the block left and where it landed, are `numbers.rs`.
use super::super::super::command::kept_line;
use super::super::super::Engine;
use super::number::spell;
use super::shift::Shift;
use super::{parts, Parts};
use crate::lines::{Carry, Kind, Line};
use std::ops::Range;

mod numbers;

pub(in crate::engine::commands) use numbers::Written;

/// What arrives: lines (old indices), or a photo's source alone.
#[derive(Clone)]
pub(in crate::engine::commands) enum Arriving<'a> {
    Lines(Range<usize>),
    Image(&'a str),
}

/// What the first line's marker becomes.
#[derive(Clone, Debug)]
enum Marker {
    /// Written as it is: its own marker, gap and box, or a new `- `.
    As(String),
    /// Counting among the numbered item below: its digits as spelled (a
    /// trial writes them) and its delimiter.
    Numbered { like: String, delimiter: u8 },
}

/// The kind the first line must still read as.
#[derive(Clone, Copy, Debug)]
enum Keeps {
    Plain,
    Item { ordered: bool, task: Option<bool> },
}

/// How a block arrives: its first line's new prefix, and how the lines
/// under it move.
#[derive(Clone, Debug)]
pub(in crate::engine::commands) struct Landing {
    space: String,
    marker: Marker,
    /// The gap and box after a counted marker.
    after: String,
    /// Where the first line's text starts in its old text.
    cut: usize,
    keeps: Keeps,
    /// A plain line or a photo becomes an item.
    pub becomes_item: bool,
    pub shift: Option<Shift>,
}

impl Landing {
    /// The delimiter of the numbered list the first line counts in.
    pub(super) fn counts(&self) -> Option<u8> {
        match self.marker {
            Marker::Numbered { delimiter, .. } => Some(delimiter),
            Marker::As(_) => None,
        }
    }

    /// The first line's leading whitespace where it lands.
    pub(super) fn space(&self) -> &str {
        &self.space
    }

    /// The first line, old text `body`, as it lands with `number` (`None`
    /// writes the digits of the item below, as a trial does): its new body,
    /// where its text starts in it, and where a `\` was written into the
    /// text (relative to the text's start), if one was.
    pub(in crate::engine::commands) fn first_line(
        &self,
        body: &str,
        number: Option<i128>,
    ) -> Written {
        let marker = match &self.marker {
            Marker::As(marker) => marker.clone(),
            Marker::Numbered { like, delimiter } => {
                let digits = number.map_or_else(|| like.clone(), |n| spell(n, like));
                format!("{digits}{}{}", *delimiter as char, self.after)
            }
        };
        let prefix = format!("{}{marker}", self.space);
        let text = &body[self.cut..];
        let keeps = self.keeps;
        let written = kept_line(&Carry::default(), &prefix, text, |read: &Line| {
            read.quote == 0
                && match (keeps, &read.kind) {
                    (Keeps::Plain, Kind::Plain { .. }) => true,
                    (
                        Keeps::Item { ordered, task },
                        Kind::List {
                            ordered: o,
                            task: t,
                            ..
                        },
                    ) => ordered == *o && task == *t,
                    _ => false,
                }
        });
        let new = &written[prefix.len()..];
        let escape = (new.len() != text.len()).then(|| {
            text.bytes()
                .zip(new.bytes())
                .position(|(a, b)| a != b)
                .unwrap_or(text.len())
        });
        Written {
            old_cut: self.cut,
            new_cut: prefix.len(),
            escape,
            body: written,
        }
    }
}

/// The first line of what arrives, as written.
struct First<'a> {
    body: &'a str,
    line: Option<&'a Line>,
    part: Option<Parts>,
}

impl First<'_> {
    fn space(&self) -> &str {
        self.part
            .as_ref()
            .map_or("", |p| &self.body[p.quote..p.space])
    }

    /// Its marker, the gap after it and its box, as written.
    fn marker(&self) -> String {
        let marker = self
            .part
            .as_ref()
            .map(|p| &self.body[p.marker.start..p.content]);
        marker.unwrap_or("").to_owned()
    }

    /// The box it has, as written, with the space after it.
    fn held_box(&self) -> Option<&str> {
        let part = self.part.as_ref()?;
        matches!(self.line?.kind, Kind::List { task: Some(_), .. })
            .then(|| &self.body[part.content - 4..part.content])
    }

    fn kind(&self) -> Option<Keeps> {
        match self.line.map(|line| &line.kind) {
            Some(Kind::List { ordered, task, .. }) => Some(Keeps::Item {
                ordered: *ordered,
                task: *task,
            }),
            _ => None,
        }
    }

    /// Landing with leading whitespace `space` and `marker`.
    fn land(&self, space: &str, marker: Marker, after: &str, keeps: Keeps) -> Landing {
        let item = self.kind().is_some();
        Landing {
            space: space.to_owned(),
            marker,
            after: after.to_owned(),
            cut: self.part.as_ref().map_or(0, |p| p.content),
            keeps,
            becomes_item: !item,
            shift: (item && self.space() != space).then(|| Shift {
                from: self.space().to_owned(),
                to: space.to_owned(),
            }),
        }
    }

    /// Outside any list: an item to the left margin as written, an
    /// indented plain line without its indent.
    fn outside(&self) -> Option<Landing> {
        match (self.kind(), self.line.map(|line| &line.kind)) {
            (Some(keeps), _) if !self.space().is_empty() => {
                Some(self.land("", Marker::As(self.marker()), "", keeps))
            }
            (None, Some(Kind::Plain { indent })) if *indent > 0 => Some(Landing {
                becomes_item: false,
                ..self.land("", Marker::As(String::new()), "", Keeps::Plain)
            }),
            _ => None,
        }
    }

    /// Strictly inside a list, above line `below` (text `body`).
    fn inside(&self, body: &str, below: &Line) -> Landing {
        let part = parts(body, below);
        let space = &body[part.quote..part.space];
        let Kind::List {
            ordered,
            task,
            text: marker,
            ..
        } = &below.kind
        else {
            // Under an item: its whitespace, and the block's own marker.
            return match self.kind() {
                Some(keeps) => self.land(space, Marker::As(self.marker()), "", keeps),
                None => {
                    let keeps = Keeps::Item {
                        ordered: false,
                        task: None,
                    };
                    self.land(space, Marker::As("- ".to_owned()), "", keeps)
                }
            };
        };
        let gap = &body[marker.end..marker.end + 1];
        match (*ordered, self.held_box(), self.kind()) {
            (true, None, _) => {
                let numbered = Marker::Numbered {
                    like: body[marker.start..marker.end - 1].to_owned(),
                    delimiter: body.as_bytes()[marker.end - 1],
                };
                let keeps = Keeps::Item {
                    ordered: true,
                    task: None,
                };
                self.land(space, numbered, gap, keeps)
            }
            // A box stays: among numbers the task keeps its own bullet.
            (true, Some(_), Some(keeps)) => self.land(space, Marker::As(self.marker()), "", keeps),
            (_, held, own) => {
                let boxed = held.or(task.map(|_| "[ ] ")).unwrap_or("");
                let written = format!("{}{gap}{boxed}", &body[marker.clone()]);
                let keeps = Keeps::Item {
                    ordered: false,
                    task: match (own, held) {
                        (Some(Keeps::Item { task, .. }), Some(_)) => task,
                        _ => task.map(|_| false),
                    },
                };
                self.land(space, Marker::As(written), "", keeps)
            }
        }
    }
}

impl Engine {
    /// How `arriving` lands at boundary `slot`, `inside` a list (strictly
    /// between two of its lines) or not; `None` when it lands as written.
    pub(in crate::engine::commands) fn landing(
        &self,
        arriving: &Arriving,
        slot: usize,
        inside: bool,
    ) -> Option<Landing> {
        let first = match arriving {
            Arriving::Lines(lines) => {
                let entry = self.line(lines.start);
                First {
                    body: entry.body(),
                    line: Some(&entry.line),
                    part: Some(parts(entry.body(), &entry.line)),
                }
            }
            Arriving::Image(source) => First {
                body: source,
                line: None,
                part: None,
            },
        };
        if !inside {
            return first.outside();
        }
        let below = self.line(slot);
        Some(first.inside(below.body(), &below.line))
    }
}
