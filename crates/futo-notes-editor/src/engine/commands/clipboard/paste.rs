//! Paste: the pasted text written as it is.
//!
//! One trailing copied line ending is dropped and every pasted line ending
//! takes the caret line's spelling (a lone `\r` is an ordinary character,
//! as everywhere in a note). Then:
//!
//! - In code the text goes in verbatim (`code_paste.rs`).
//! - Elsewhere, pasted lines after the first take the caret line's quote
//!   markers. A pasted list also takes the caret line's indent, on every
//!   line, so pasted items sit beside the caret's item and nested ones keep
//!   their nesting.
//! - A first pasted line that is a block (heading, list item, quote,
//!   divider, fence) starts a line of its own: after the text before the
//!   caret, or in place of the caret line's marker when no text is before
//!   the caret (in place of its quote markers too when the pasted line is
//!   quoted, so cut quote lines paste back without nesting).
//! - Text after the caret joins the last pasted line, unless that line is a
//!   block or leaves a fence open: then it keeps a line of its own with the
//!   caret line's markers, and a fence the paste opened is closed before it.
//! - A paste that ends with a closed code block leaves the caret on the line
//!   after it, opening an empty one where no ordinary line follows.
//! - Marks the caret is inside close at the first pasted line break and open
//!   again on the line the text after the caret is on.
//! - One pasted line holding a link never lands inside another link's
//!   text: that link closes before it and opens again after it.
//!
//! Outside table lines a paste lands without the command guard, like typing.
//! A table-cell paste keeps the table family's rules, and a paste elsewhere
//! on a table line remains guarded.
use super::super::super::command::{Command, Edit};
use super::super::super::Engine;
use super::super::blocks::Joined;
use super::super::fences::{leading, line_after_closing};
use super::super::lists::parts;
use super::super::marks::split;
use super::code_paste::PastedCode;
use crate::lines::block::OpenFence;
use crate::lines::{block, line_spans, Carry, FenceRole, Kind, Line, SpanKind};
use crate::{DisplayRange, EditorError, InputAction};

/// Where the caret lands after a shaped paste.
enum Landing {
    /// At this offset of the written text.
    At(usize),
    /// On the line after the written text: the paste ended with a closed
    /// code block and nothing else is on its line.
    BelowBlock,
}

/// `text` with one trailing line ending dropped (unless that is all it
/// is) and every `\n` or `\r\n` spelled `newline`.
fn normalized(text: &str, newline: &str) -> String {
    let text = match text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
    {
        Some(rest) if !rest.is_empty() => rest,
        _ => text,
    };
    let mut out = String::with_capacity(text.len());
    let mut pieces = text.split('\n').peekable();
    while let Some(piece) = pieces.next() {
        if pieces.peek().is_some() {
            out.push_str(piece.strip_suffix('\r').unwrap_or(piece));
            out.push_str(newline);
        } else {
            out.push_str(piece);
        }
    }
    out
}

/// `text` read alone as one line.
fn read_alone(text: &str) -> Line {
    block::read_line(&mut Carry::default(), text, 0)
}

/// Whether a line read alone is a block: something other than text.
fn is_block(line: &Line) -> bool {
    line.quote > 0
        || matches!(
            line.kind,
            Kind::Heading { .. } | Kind::List { .. } | Kind::Divider | Kind::Fence { .. }
        )
}

/// Whether `text`, read alone as `line`, holds a link.
fn has_link(line: &Line, text: &str) -> bool {
    line_spans(text, line)
        .iter()
        .any(|span| matches!(span.kind, SpanKind::Link { .. }))
}

/// Where a pasted link goes on the joined line, so it is not inside
/// another link's text: before a link whose text the caret starts, after
/// one it ends, and inside one between that link's closing and its
/// opening again. Other marks stay around it. `None` outside links.
fn link_split(joined: &Joined) -> Option<(usize, String, String)> {
    let caret = joined.caret;
    let text = &joined.text;
    let link = joined.spans.iter().find(|span| {
        matches!(span.kind, SpanKind::Link { .. })
            && span.open.end <= caret
            && caret <= span.close.start
    });
    let link = link?;
    Some(if caret == link.open.end {
        (link.open.start, String::new(), String::new())
    } else if caret == link.close.start {
        (link.close.end, String::new(), String::new())
    } else {
        (
            caret,
            text[link.close.clone()].to_owned(),
            text[link.open.clone()].to_owned(),
        )
    })
}

/// Quote markers to write text after: a lone `>` gains a space.
fn spaced(quote: &str) -> String {
    let mut out = quote.to_owned();
    if !out.is_empty() && !out.ends_with([' ', '\t']) {
        out.push(' ');
    }
    out
}

impl Engine {
    pub(super) fn paste_command(
        &self,
        range: DisplayRange,
        text: &str,
    ) -> Result<Option<Command>, EditorError> {
        self.check_display_range(range)?;
        let range = self.outside_crlf(range);
        if self.touches_metadata(range) {
            return Err(EditorError::InvalidRange);
        }
        let range = self.in_body(range);
        let caret_line = self.line_of(self.source_selection(range).start);
        let newline = self.empty_line_ending(caret_line);
        let text = normalized(text, &newline);
        if text.is_empty() && range.start == range.end {
            return Ok(None);
        }
        // A paste inside one table cell stays in it (the table family's). A
        // caret on a row outside its cells pastes as it would elsewhere; a
        // selection across cells would rewrite the grid, and is refused.
        match self.cell_paste(range, &text) {
            Ok(Some(command)) => return Ok(Some(command)),
            Ok(None) => {}
            Err(EditorError::InvalidRange) if range.start == range.end => {}
            Err(EditorError::InvalidRange) => return Err(EditorError::UnrepresentableFormat),
            Err(error) => return Err(error),
        }
        // A block selected as one object is replaced whole, as prose.
        let whole_block = self.block_selected && range == self.selection;
        if let Some(touch) = self.touch(range).filter(|_| !whole_block) {
            let pasted = PastedCode {
                text: &text,
                newline: &newline,
            };
            let mut command = self.code_paste(range, touch, pasted);
            command.typed = true;
            return Ok(Some(command));
        }
        let pasted: Vec<&str> = text.split(newline.as_str()).collect();
        let first = read_alone(pasted[0]);
        // Over a selected list marker one line lands as typing does, so a
        // pasted marker takes the selected one's place.
        let shaped =
            pasted.len() > 1 || (is_block(&first) && self.selected_marker(range).is_none());
        if !shaped {
            if let Some(mut command) = self.carried_paste(range, &text) {
                command.typed = true;
                return Ok(Some(command));
            }
        }
        // The empty line that shows for front matter's body takes the text
        // after a line ending, as typing there does.
        let empty = range.start == range.end && self.empty_line(range.start.0).is_some();
        let joined = if empty { None } else { self.joined(range) };
        let command = joined.and_then(|joined| {
            if shaped {
                let (out, landing) = shape(&joined, &pasted, &first, &newline);
                Some(match landing {
                    Landing::At(caret) => self.written(&joined, &out, caret),
                    Landing::BelowBlock => self.below_pasted_block(&joined, out, &newline),
                })
            } else if has_link(&first, pasted[0]) {
                let (at, closes, opens) = link_split(&joined)?;
                let body = &joined.text;
                let left = format!("{}{closes}{}", &body[..at], pasted[0]);
                let out = format!("{left}{opens}{}", &body[at..]);
                Some(self.written(&joined, &out, left.len()))
            } else {
                None
            }
        });
        let mut command = command.unwrap_or_else(|| self.exact(range, &text));
        command.typed = !matches!(self.line(caret_line).line.kind, Kind::Table { .. });
        Ok(Some(command))
    }

    /// The joined line rewritten as `out`, the caret at `caret` in it. The
    /// line above is named too: a pasted delimiter row may make it a header.
    fn written(&self, joined: &Joined, out: &str, caret: usize) -> Command {
        let command = self.rejoin(joined, out, caret);
        Command::new(
            command.edits,
            joined.first.saturating_sub(1)..joined.last + 1,
            command.selection,
        )
    }

    /// The joined line rewritten as `out`, which ends with a closed code
    /// block, the caret at the start of the line after it. Where that line
    /// opens another block, or there is none, an empty line is opened after
    /// the block as `OpenLineAfterCodeBlock` opens one, and the caret is on it.
    fn below_pasted_block(&self, joined: &Joined, mut out: String, newline: &str) -> Command {
        let next = joined.last + 1;
        let ordinary = next < self.line_count()
            && !matches!(
                self.line(next).line.kind,
                Kind::Fence {
                    role: FenceRole::Open,
                    ..
                }
            );
        let own = self.line(joined.last).ending();
        if ordinary {
            let caret = out.len() + own.len();
            return self.written(joined, &out, caret);
        }
        let ending = if own.is_empty() { newline } else { own };
        let closing = out.rsplit(newline).next().unwrap_or_default();
        let opened = line_after_closing(ending, closing);
        out.push_str(&opened);
        let caret = out.len();
        self.written(joined, &out, caret)
    }

    /// The text replacing the selection, exactly as given, as typing it
    /// would land: in the formats the caret carries.
    fn exact(&self, range: DisplayRange, text: &str) -> Command {
        let plan = self.plan_input(range, text, InputAction::Typing);
        let first = self.line_of(plan.range.start);
        let last = self.line_of(plan.range.end);
        Command::new(
            vec![Edit::new(plan.range, plan.inserted)],
            first.saturating_sub(1)..last + 1,
            plan.caret..plan.caret,
        )
    }
}

/// The joined line with `pasted` (its lines, the first read alone as
/// `first`) written at its caret, and where the caret lands: after the last
/// pasted line, or on the line after it when that line closes a code block.
fn shape(joined: &Joined, pasted: &[&str], first: &Line, newline: &str) -> (String, Landing) {
    let body = joined.text.as_str();
    let line = &joined.line;
    let part = parts(body, line);
    // A divider's or fence's text is no marker: all of it follows the caret
    // on a line of its own.
    let own_line = matches!(line.kind, Kind::Divider | Kind::Fence { .. });
    let content = if own_line {
        0
    } else {
        part.content.min(body.len())
    };
    let head = &body[..content];
    let quote = spaced(&body[..part.quote]);
    let indent = match line.kind {
        Kind::List { .. } | Kind::Plain { .. } => &body[part.quote..part.space],
        _ => "",
    };
    let caret = joined.caret.clamp(content, body.len());
    let first_block = is_block(first);
    let lead_indent = if matches!(first.kind, Kind::List { .. }) {
        indent
    } else {
        ""
    };
    let in_place = first_block && body[content..caret].trim_matches([' ', '\t']).is_empty();
    let rest_prefix = if in_place && first.quote > 0 {
        String::new()
    } else {
        format!("{quote}{lead_indent}")
    };
    let (at, closes, opens) = if own_line {
        (caret, String::new(), String::new())
    } else {
        split(body, line, &joined.spans, caret)
    };
    let tail = &body[at..];

    // Each new line without its ending; the first holds the text before the
    // caret.
    let mut lines: Vec<String> = Vec::with_capacity(pasted.len() + 2);
    let mut lead = String::new();
    if in_place {
        if first.quote == 0 {
            lead.push_str(&quote);
        }
        lead.push_str(lead_indent);
    } else {
        lead.push_str(&body[..at]);
        if first_block {
            lead.push_str(&closes);
            lines.push(lead);
            lead = rest_prefix.clone();
        }
    }
    for (index, text) in pasted.iter().enumerate() {
        let mut new = if index == 0 {
            std::mem::take(&mut lead)
        } else if text.is_empty() {
            rest_prefix.trim_end().to_owned()
        } else {
            rest_prefix.clone()
        };
        new.push_str(text);
        if index == 0 && !first_block && pasted.len() > 1 {
            new.push_str(&closes);
        }
        lines.push(new);
    }
    let last = lines.len() - 1;
    let open = open_fence(&joined.carry, &lines);
    let last_block = is_block(&read_alone(pasted[pasted.len() - 1]));
    let alone =
        (last_block || open.is_some() || own_line) && !tail.trim_matches([' ', '\t']).is_empty();
    let mut caret_line = (last, lines[last].len());
    if let Some((fence, indent)) = open {
        let run = (fence.ch as char).to_string().repeat(fence.len);
        lines.push(format!("{indent}{run}"));
    }
    if alone {
        lines.push(format!("{head}{opens}{tail}"));
    } else if !tail.is_empty() || !opens.is_empty() {
        joined_tail(&mut lines[last], pasted[pasted.len() - 1], &opens, tail);
        caret_line.1 += opens.len();
    }
    let ends_block = closes_block(&joined.carry, &lines[..=last]);
    if ends_block && alone {
        let column = open_line_before_tail(&mut lines, last).unwrap_or(head.len() + opens.len());
        caret_line = (last + 1, column);
    }
    let mut out = String::new();
    let mut caret = 0;
    for (index, text) in lines.iter().enumerate() {
        if index > 0 {
            out.push_str(newline);
        }
        if index == caret_line.0 {
            caret = out.len() + caret_line.1;
        }
        out.push_str(text);
    }
    if ends_block && !alone {
        return (out, Landing::BelowBlock);
    }
    (out, Landing::At(caret))
}

/// `tail` joined to the last pasted line, the caret's marks opening again
/// where its pasted `text` starts.
fn joined_tail(written: &mut String, text: &str, opens: &str, tail: &str) {
    let from = written.len() - text.len();
    let start = from + read_alone(&written[from..]).content.start;
    written.insert_str(start.min(written.len()), opens);
    written.push_str(tail);
}

/// The tail line after closing fence `lines[closing]`, when it opens a block
/// of its own, gets an empty line before it at the fence's indent: the
/// caret's column on that line. `None` for any other tail, where the caret
/// goes to the tail's own text start, after its markers.
fn open_line_before_tail(lines: &mut Vec<String>, closing: usize) -> Option<usize> {
    let tail = lines.len() - 1;
    if !matches!(read_alone(&lines[tail]).kind, Kind::Fence { .. }) {
        return None;
    }
    let indent = leading(&lines[closing]).to_owned();
    let column = indent.len();
    lines.insert(tail, indent);
    Some(column)
}

/// Whether the last of `lines` (read after `carry`) closes a code block.
fn closes_block(carry: &Carry, lines: &[String]) -> bool {
    let mut carry = carry.clone();
    let mut last = None;
    for text in lines {
        last = Some(block::read_line(&mut carry, text, 0).kind);
    }
    matches!(
        last,
        Some(Kind::Fence {
            role: FenceRole::Close,
            ..
        })
    )
}

/// The fence `lines` (read after `carry`) leave open that was not open
/// before them, and its opening line's indent.
fn open_fence(carry: &Carry, lines: &[String]) -> Option<(OpenFence, String)> {
    if carry.fence.is_some() {
        return None;
    }
    let mut carry = carry.clone();
    let mut opened = None;
    for text in lines {
        let was = carry.fence.is_some();
        block::read_line(&mut carry, text, 0);
        if !was && carry.fence.is_some() {
            opened =
                Some(text[..text.len() - text.trim_start_matches([' ', '\t']).len()].to_owned());
        }
    }
    Some((carry.fence?, opened?))
}
