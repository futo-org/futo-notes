//! A one-line paste at a caret carrying formats the inline family's typing
//! cannot shape, because the text does not show as typed (a link, an
//! image, a wikilink): the pasted text goes inside the carried formats'
//! house marks, kept only when the line then reads as intended.
use super::super::super::command::{Command, Edit};
use super::super::super::project::format_of;
use super::super::super::Engine;
use crate::lines::{block, line_spans, Carry, Kind, Line};
use crate::{DisplayRange, InlineFormat};

/// Outermost first: code goes innermost so the other marks can surround it.
const ORDER: [InlineFormat; 4] = [
    InlineFormat::Bold,
    InlineFormat::Italic,
    InlineFormat::Strike,
    InlineFormat::Code,
];

fn bit(format: InlineFormat) -> u8 {
    match format {
        InlineFormat::Bold => 1,
        InlineFormat::Italic => 2,
        InlineFormat::Strike => 4,
        InlineFormat::Code => 8,
    }
}

fn bits(formats: &[InlineFormat]) -> u8 {
    formats.iter().fold(0, |all, format| all | bit(*format))
}

/// The house marks of `format` around `text`.
fn house(format: InlineFormat, text: &str) -> (String, String) {
    match format {
        InlineFormat::Bold => ("**".into(), "**".into()),
        InlineFormat::Italic => ("*".into(), "*".into()),
        InlineFormat::Strike => ("~~".into(), "~~".into()),
        InlineFormat::Code => {
            let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
            let ticks = "`".repeat(longest + 1);
            let pad = if text.starts_with('`') || text.ends_with('`') {
                " "
            } else {
                ""
            };
            (format!("{ticks}{pad}"), format!("{pad}{ticks}"))
        }
    }
}

/// `text` read as one line after `carry`: its reading and its visible
/// characters, each with the formats it shows in and its line offset.
fn visible(text: &str, carry: &Carry) -> (Line, Vec<(usize, char, u8)>) {
    let line = block::read_line(&mut carry.clone(), text, 0);
    let spans = line_spans(text, &line);
    let hidden = |at: usize| {
        line.marker.contains(&at)
            || spans
                .iter()
                .any(|span| span.open.contains(&at) || span.close.contains(&at))
    };
    let shown = text[..line.range.end]
        .char_indices()
        .filter(|(at, _)| !hidden(*at))
        .map(|(at, ch)| {
            let style = spans
                .iter()
                .filter(|span| {
                    let inside = if span.open.is_empty() && span.close.is_empty() {
                        span.range.clone()
                    } else {
                        span.open.end..span.close.start
                    };
                    inside.contains(&at)
                })
                .filter_map(|span| format_of(&span.kind))
                .fold(0, |all, format| all | bit(format));
            (at, ch, style)
        })
        .collect();
    (line, shown)
}

/// Whether two readings are the same block at the same place; a blank
/// line that gains text is the plain line typing there makes.
fn same_block(a: &Line, b: &Line) -> bool {
    let kind = |line: &Line| match line.kind {
        Kind::Blank => std::mem::discriminant(&Kind::Plain { indent: 0 }),
        ref kind => std::mem::discriminant(kind),
    };
    kind(a) == kind(b) && a.quote == b.quote && a.marker == b.marker
}

impl Engine {
    /// `text` (one line, no block) pasted at the collapsed caret `range` in
    /// the formats the caret carries, when typing cannot shape it: each
    /// carried format the caret's reading lacks is written around it in its
    /// house marks. Kept only when every pasted visible character then
    /// shows in the carried formats (plus its own; in code, every pasted
    /// character shows, literally) and every other one as before; `None`
    /// pastes plain.
    pub(super) fn carried_paste(&self, range: DisplayRange, text: &str) -> Option<Command> {
        let carried = self.formats.as_ref()?;
        if range.start != range.end
            || range != self.selection
            || self.formatted_input(range, text).is_some()
        {
            return None;
        }
        let at = self.caret_source();
        let index = self.line_of(at);
        let entry = self.line(index);
        if !matches!(
            entry.line.kind,
            Kind::Plain { .. } | Kind::Blank | Kind::Heading { .. } | Kind::List { .. }
        ) {
            return None;
        }
        let have = self.formats_at(at);
        if have.iter().any(|format| !carried.contains(format)) {
            // Typing cannot take a format off here; neither can a paste.
            return None;
        }
        let need: Vec<InlineFormat> = ORDER
            .into_iter()
            .filter(|format| carried.contains(format) && !have.contains(format))
            .collect();
        if need.is_empty() {
            return None;
        }
        let mut wrapped = text.to_owned();
        for format in need.iter().rev() {
            let (open, close) = house(*format, &wrapped);
            wrapped = format!("{open}{wrapped}{close}");
        }
        let local = at - self.line_start(index);
        let body = entry.body();
        let after = format!("{}{wrapped}{}", &body[..local], &body[local..]);
        let (old_line, old) = visible(body, &entry.carry);
        let (new_line, new) = visible(&after, &entry.carry);
        // In code the pasted text shows literally, every character of it.
        let own: Vec<(usize, char, u8)> = if need.contains(&InlineFormat::Code) {
            text.char_indices().map(|(at, ch)| (at, ch, 0)).collect()
        } else {
            visible(text, &Carry::default()).1
        };
        let split = old.partition_point(|(src, ..)| *src < local);
        let carried = bits(carried);
        let want = old[..split]
            .iter()
            .map(|&(_, ch, style)| (ch, style))
            .chain(own.iter().map(|&(_, ch, style)| (ch, style | carried)))
            .chain(old[split..].iter().map(|&(_, ch, style)| (ch, style)));
        let got = new.iter().map(|&(_, ch, style)| (ch, style));
        if !same_block(&old_line, &new_line) || !want.eq(got) {
            return None;
        }
        let caret = at + wrapped.len();
        Some(Command::new(
            vec![Edit::insert(at, wrapped)],
            index.saturating_sub(1)..index + 1,
            caret..caret,
        ))
    }
}
