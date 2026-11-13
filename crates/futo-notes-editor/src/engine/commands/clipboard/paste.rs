//! Paste: the pasted text written as it is.
//!
//! One trailing copied line ending is dropped and every pasted line ending
//! takes the caret line's spelling (a lone `\r` is an ordinary character,
//! as everywhere in a note). Then:
//!
//! - In code the text goes in verbatim. When a pasted line would close the
//!   fence, the fence grows longer than it, so the text stays code.
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
//! - Marks the caret is inside close at the first pasted line break and open
//!   again on the line the text after the caret is on.
//! - One pasted line holding a link never lands inside another link's
//!   text: that link closes before it and opens again after it.
//!
//! A paste is a command, not typing: it runs behind the one guard, naming
//! the lines it writes and the line above them (so a pasted delimiter row
//! may make that line a table header). A paste that would change how any
//! other line reads, such as rows below a table cell it splits, is
//! cancelled.
use super::super::super::command::{Command, Edit};
use super::super::super::Engine;
use super::super::blocks::Joined;
use super::super::fences::Touch;
use super::super::lists::parts;
use super::super::marks::split;
use crate::lines::block::OpenFence;
use crate::lines::{block, line_spans, Carry, Kind, Line, SpanKind};
use crate::{DisplayRange, EditorError};

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

/// The length of the run of fence characters `ch` a line is made of,
/// whitespace around it aside; 0 when it has anything else.
fn fence_run(line: &str, ch: u8) -> usize {
    let own = line.trim_matches([' ', '\t']);
    if !own.is_empty() && own.bytes().all(|b| b == ch) {
        own.len()
    } else {
        0
    }
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
        let caret_line = self.line_of(self.source_selection(range).start);
        let newline = self.empty_line_ending(caret_line);
        let text = normalized(text, &newline);
        if text.is_empty() && range.start == range.end {
            return Ok(None);
        }
        if let Some(touch) = self.touch(range) {
            return Ok(Some(self.code_paste(range, touch, &text, &newline)));
        }
        let pasted: Vec<&str> = text.split(newline.as_str()).collect();
        let first = read_alone(pasted[0]);
        let shaped = pasted.len() > 1 || is_block(&first);
        // The empty line that shows for front matter's body takes the text
        // after a line ending, as typing there does.
        let empty = range.start == range.end && self.empty_line(range.start.0).is_some();
        let joined = if empty { None } else { self.joined(range) };
        let command = joined.and_then(|joined| {
            if shaped {
                let (out, caret) = shape(&joined, &pasted, &first, &newline);
                Some(self.written(&joined, &out, caret))
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
        Ok(Some(command.unwrap_or_else(|| self.exact(range, &text))))
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

    /// The text replacing the selection, exactly as given.
    fn exact(&self, range: DisplayRange, text: &str) -> Command {
        let plan = self.plan(range, text);
        let first = self.line_of(plan.range.start);
        let last = self.line_of(plan.range.end);
        Command::new(
            vec![Edit::new(plan.range, plan.inserted)],
            first.saturating_sub(1)..last + 1,
            plan.caret..plan.caret,
        )
    }

    /// Paste in code: the text verbatim, the fence lengthened (opening and
    /// closing line alike) when a line would otherwise close it.
    fn code_paste(&self, range: DisplayRange, touch: Touch, text: &str, newline: &str) -> Command {
        let index = match &touch {
            Touch::Code(lines) => lines.start,
            Touch::Empty(open) => *open,
        };
        let fence = self.fence_around(index).expect("code is in a fence");
        let plan = self.plan(range, text);
        // The code lines as they will read: the pasted text with the rest
        // of the lines it lands on.
        let first = self.line_of(plan.range.start);
        let last = self.line_of(plan.range.end);
        let code = |line: usize| fence.code().contains(&line);
        let before = if code(first) {
            self.source_slice(self.line_start(first)..plan.range.start)
        } else {
            String::new()
        };
        let after = if code(last) {
            let end = self.line_start(last) + self.line(last).body_len();
            self.source_slice(plan.range.end..end.max(plan.range.end))
        } else {
            String::new()
        };
        let lines = format!("{before}{}{after}", plan.inserted);
        let opening = self.line(fence.open).body();
        let indent = opening.len() - opening.trim_start_matches([' ', '\t']).len();
        let ch = opening.as_bytes()[indent];
        let run = opening[indent..].bytes().take_while(|&b| b == ch).count();
        let longest = lines
            .split(newline)
            .map(|line| fence_run(line, ch))
            .max()
            .unwrap_or(0);
        let mut edits = vec![Edit::new(plan.range.clone(), plan.inserted.clone())];
        let mut caret = plan.caret;
        if longest >= run {
            let extra = (ch as char).to_string().repeat(longest + 1 - run);
            let open_at = self.line_start(fence.open) + indent + run;
            edits.push(Edit::insert(open_at, extra.clone()));
            caret += extra.len();
            if fence.closed {
                let closing = self.line(fence.end).body();
                let lead = closing.len() - closing.trim_start_matches([' ', '\t']).len();
                let close_at = self.line_start(fence.end) + lead;
                edits.push(Edit::insert(close_at, extra));
            }
        }
        Command::new(edits, fence.open..fence.last() + 1, caret..caret)
    }
}

/// The joined line with `pasted` (its lines, the first read alone as
/// `first`) written at its caret, and the caret after the last pasted line.
fn shape(joined: &Joined, pasted: &[&str], first: &Line, newline: &str) -> (String, usize) {
    let body = joined.text.as_str();
    let line = &joined.line;
    let part = parts(body, line);
    let head = &body[..part.content.min(body.len())];
    let quote = spaced(&body[..part.quote]);
    let indent = match line.kind {
        Kind::List { .. } | Kind::Plain { .. } => &body[part.quote..part.space],
        _ => "",
    };
    let caret = joined.caret.clamp(part.content.min(body.len()), body.len());
    let first_block = is_block(first);
    let lead_indent = if matches!(first.kind, Kind::List { .. }) {
        indent
    } else {
        ""
    };
    let in_place = first_block
        && body[part.content..caret]
            .trim_matches([' ', '\t'])
            .is_empty();
    let rest_prefix = if in_place && first.quote > 0 {
        String::new()
    } else {
        format!("{quote}{lead_indent}")
    };
    let (at, closes, opens) = split(body, line, &joined.spans, caret);
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
    let alone = (last_block || open.is_some()) && !tail.trim_matches([' ', '\t']).is_empty();
    let mut caret_line = (last, lines[last].len());
    if let Some((fence, indent)) = open {
        let run = (fence.ch as char).to_string().repeat(fence.len);
        lines.push(format!("{indent}{run}"));
    }
    if alone {
        lines.push(format!("{head}{opens}{tail}"));
    } else if !tail.is_empty() || !opens.is_empty() {
        // The marks open again where the last pasted line's text starts.
        let text = &lines[last];
        let from = text.len() - pasted[pasted.len() - 1].len();
        let start = from + read_alone(&text[from..]).content.start;
        let start = if start > text.len() {
            text.len()
        } else {
            start
        };
        lines[last].insert_str(start, &opens);
        caret_line.1 += opens.len();
        lines[last].push_str(tail);
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
    (out, caret)
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
