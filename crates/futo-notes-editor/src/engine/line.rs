//! One line of the note: its text, its reading, and how it shows.
//!
//! A line shows as its text with its hidden pieces removed, followed by its
//! line ending. The exceptions, each one small rule:
//!
//! 1. Frames. An opening fence or front matter line is hidden with its
//!    ending. A closing line is hidden with its own ending; on the note's
//!    last line it has none, so it hides the ending before it instead. The
//!    display then has fewer lines than the note.
//! 2. An empty code block (an opening fence with no line before its closing
//!    fence or the note's end) shows as one empty line with no text behind
//!    it. So does front matter closed on the note's last line, where the
//!    empty line is the note's body.
//! 3. Typing on such an empty line writes a line ending, then the text, at
//!    the end of the line's hidden text, except immediately after typing an
//!    opening fence, when the caret stays on its hidden language.
//! 4. A divider shows as one U+FFFC, which renderers draw as a rule.
//! 5. Typing at a divider's edge writes the text on a line of its own
//!    beside the rule (`edit/plan.rs` `beside_divider`), in its quotes.
//! 6. An empty quote line with no space after its last `>` (`>`, `> >`)
//!    shows as an empty quoted line. Typing there text that as typed would
//!    take the line out of its quote (`>x` is plain) writes the space the
//!    quote needs, then the text (`edit/plan.rs` `quote_space`).
//!
//! Front matter lines show their whole text; a table's delimiter row shows
//! as typed. Everything else hides its marker (quote, list, heading markers
//! and an indented line's leading whitespace, which renderers draw from the
//! line's indent) and its inline syntax.
use super::store::Size;
use crate::lines::{block, line_spans, Carry, FenceRole, FrontMatterRole, Kind, Line, Span};
use crate::lines::{SpanKind, TableRole};
use std::ops::Range;

pub(crate) const DIVIDER: &str = "\u{fffc}";

/// Whether, and how, a line shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Role {
    /// Text minus hidden pieces.
    Text,
    /// A frame line: nothing shows.
    Hidden,
    /// An empty line with no text behind it (rule 2).
    Empty,
}

/// What a hidden piece of a shown line is, which decides where a caret may
/// stand around it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Cut {
    /// The line's leading marker: a caret stands only after it.
    Marker,
    /// Inline syntax (a span's opening or closing marks): a caret may stand
    /// on either side.
    Syntax,
    /// An escape's backslash: a caret stands only before it, never between
    /// it and the character it escapes.
    Escape,
    /// A divider, shown as one U+FFFC (rule 4).
    Divider,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct View {
    pub role: Role,
    /// Whether the line ending shows.
    pub ending: bool,
    /// Hidden pieces of a shown line, in order, line-relative.
    pub cuts: Vec<(Range<usize>, Cut)>,
}

/// One line. Every offset in it is relative to the line's start.
#[derive(Clone, Debug)]
pub(crate) struct Entry {
    /// The line with its ending.
    pub text: String,
    /// What the lines above hand to this line.
    pub carry: Carry,
    pub line: Line,
    pub spans: Vec<Span>,
    /// One bit per wikilink target leaf on the line (`link_bit`), so a
    /// note-id delivery skips lines whose links it cannot change.
    pub links: u64,
    pub view: View,
    pub size: Size,
}

/// The bit a wikilink target's last path component hashes to. A note-id
/// change can only re-resolve links whose leaf matches a changed id's leaf.
pub(crate) fn link_bit(target: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    futo_notes_wikilinks::note_id_leaf(target).hash(&mut hasher);
    1 << (hasher.finish() % 64)
}

/// What a line's display depends on beyond the line itself.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Neighbors<'a> {
    pub next: Option<&'a Kind>,
    pub next_is_last: bool,
}

impl Entry {
    /// Read `text` (one line with its ending) after `carry`; `carry` becomes
    /// the carry after it. `rest_closes_front_matter` answers, for line 1
    /// only, whether a later line is exactly `---`.
    pub fn read(text: String, carry: &mut Carry, rest_closes_front_matter: bool) -> Self {
        let before = carry.clone();
        let line = if carry.first && trimmed(&text) == "---" && rest_closes_front_matter {
            // The reader looks past line 1 for the closing `---`; hand it one.
            let mut probe = text.clone();
            if !probe.ends_with('\n') {
                probe.push('\n');
            }
            probe.push_str("---");
            let mut line = block::read_line(carry, &probe, 0);
            line.ending = text.len() - line.range.end;
            line
        } else {
            block::read_line(carry, &text, 0)
        };
        // Until `show` works out the display, the line counts as a line of
        // source with nothing shown.
        let size = Size {
            lines: 1,
            source: text.len(),
            display: 0,
            source16: text.encode_utf16().count(),
            display16: 0,
        };
        Self {
            text,
            carry: before,
            line,
            spans: Vec::new(),
            links: 0,
            view: View {
                role: Role::Text,
                ending: true,
                cuts: Vec::new(),
            },
            size,
        }
    }

    /// Read the line's inline marks (after table headers are settled).
    pub fn read_spans(&mut self) {
        self.spans = line_spans(&self.text, &self.line);
        self.links = self
            .spans
            .iter()
            .filter_map(|span| match &span.kind {
                SpanKind::Wikilink { target } => Some(link_bit(target)),
                _ => None,
            })
            .fold(0, |mask, bit| mask | bit);
    }

    /// The line without its ending.
    pub fn body(&self) -> &str {
        &self.text[..self.line.range.end]
    }

    pub fn body_len(&self) -> usize {
        self.line.range.end
    }

    pub fn ending(&self) -> &str {
        &self.text[self.line.range.end..]
    }

    /// Work out how the line shows, and its size.
    pub fn show(&mut self, neighbors: Neighbors, is_last: bool) {
        let next_closes_at_end = neighbors.next_is_last
            && matches!(
                neighbors.next,
                Some(Kind::Fence {
                    role: FenceRole::Close,
                    ..
                })
            );
        let next_closes = matches!(
            neighbors.next,
            Some(Kind::Fence {
                role: FenceRole::Close,
                ..
            })
        );
        let role = match &self.line.kind {
            Kind::Fence {
                role: FenceRole::Open,
                ..
            } if is_last || next_closes => Role::Empty,
            Kind::FrontMatter(FrontMatterRole::Close) if is_last => Role::Empty,
            Kind::Fence {
                role: FenceRole::Open | FenceRole::Close,
                ..
            }
            | Kind::FrontMatter(FrontMatterRole::Open | FrontMatterRole::Close) => Role::Hidden,
            _ => Role::Text,
        };
        let ending = role != Role::Hidden && !next_closes_at_end && !self.ending().is_empty();
        let cuts = if role == Role::Text {
            self.cuts()
        } else {
            Vec::new()
        };
        self.view = View { role, ending, cuts };
        // Sizes come from the source minus hidden pieces; opening a note
        // need not allocate a display string for every line just to count it.
        let ending16 = self.ending().encode_utf16().count();
        let (mut display, mut display16) = if role == Role::Text {
            (self.body_len(), self.size.source16 - ending16)
        } else {
            (0, 0)
        };
        for (range, cut) in &self.view.cuts {
            display -= range.len();
            display16 -= self.text[range.clone()].encode_utf16().count();
            if *cut == Cut::Divider {
                display += DIVIDER.len();
                display16 += 1;
            }
        }
        if ending {
            display += self.ending().len();
            display16 += ending16;
        }
        self.size.display = display;
        self.size.display16 = display16;
    }

    fn cuts(&self) -> Vec<(Range<usize>, Cut)> {
        let line = &self.line;
        match &line.kind {
            Kind::Divider => return vec![(0..line.range.end, Cut::Divider)],
            Kind::FrontMatter(_)
            | Kind::Table {
                role: TableRole::Delimiter,
                ..
            } => return Vec::new(),
            _ => {}
        }
        let mut cuts = Vec::new();
        if !line.marker.is_empty() {
            cuts.push((line.marker.clone(), Cut::Marker));
        }
        for span in &self.spans {
            let open = if span.kind == SpanKind::Escape {
                Cut::Escape
            } else {
                Cut::Syntax
            };
            if !span.open.is_empty() {
                cuts.push((span.open.clone(), open));
            }
            if !span.close.is_empty() {
                cuts.push((span.close.clone(), Cut::Syntax));
            }
        }
        cuts.sort_by_key(|(range, _)| range.start);
        cuts
    }

    /// The display of the line's text, without its ending.
    pub fn shown_body(&self) -> String {
        if self.view.role != Role::Text {
            return String::new();
        }
        let body = self.body();
        let mut out = String::with_capacity(body.len());
        let mut at = 0;
        for (range, cut) in &self.view.cuts {
            out.push_str(&body[at..range.start]);
            if *cut == Cut::Divider {
                out.push_str(DIVIDER);
            }
            at = range.end;
        }
        out.push_str(&body[at..]);
        out
    }

    /// The line's display, with its ending when that shows.
    pub fn display(&self) -> String {
        let mut out = self.shown_body();
        if self.view.ending {
            out.push_str(self.ending());
        }
        out
    }

    /// Display bytes of the text before the ending.
    pub fn shown_len(&self) -> usize {
        self.size.display
            - if self.view.ending {
                self.ending().len()
            } else {
                0
            }
    }

    /// The display offset of source offset `at` (both line-relative). A
    /// position inside a hidden piece maps to the piece's display point; one
    /// inside a hidden line, to the line's display start.
    pub fn to_display(&self, at: usize) -> usize {
        let body = self.body_len();
        if at > body {
            let shown = self.shown_len();
            return if self.view.ending {
                shown + at - body
            } else {
                shown
            };
        }
        if self.view.role != Role::Text {
            return 0;
        }
        let mut display = at;
        for (range, cut) in &self.view.cuts {
            if range.end <= at {
                display = display - range.len()
                    + if *cut == Cut::Divider {
                        DIVIDER.len()
                    } else {
                        0
                    };
            } else if range.start < at {
                display -= at - range.start;
                break;
            } else {
                break;
            }
        }
        display
    }

    /// Whether a caret may stand at source offset `at` around the hidden
    /// pieces (not whether `at` is a character boundary).
    pub(crate) fn allowed(&self, at: usize) -> bool {
        self.view.cuts.iter().all(|(range, cut)| match cut {
            Cut::Marker => at >= range.end,
            Cut::Syntax | Cut::Divider => at <= range.start || at >= range.end,
            Cut::Escape => at != range.end,
        })
    }

    /// Every source offset that shows at display offset `at`, as the lowest
    /// and highest. `allowed` keeps only those a caret may stand at.
    /// `None` when `at` is past the line's display.
    pub fn sources(&self, at: usize, allowed: bool) -> Option<(usize, usize)> {
        let shown = self.shown_len();
        let body = self.body_len();
        if at > shown {
            let ending = if self.view.ending {
                self.ending().len()
            } else {
                0
            };
            return (at <= shown + ending).then_some((body + at - shown, body + at - shown));
        }
        if self.view.role != Role::Text {
            return Some((body, body));
        }
        let mut found: Option<(usize, usize)> = None;
        let mut consider = |p: usize| {
            if allowed && !self.allowed(p) {
                return;
            }
            found = Some(match found {
                None => (p, p),
                Some((lo, hi)) => (lo.min(p), hi.max(p)),
            });
        };
        let mut source = 0;
        let mut display = 0;
        for (range, cut) in &self.view.cuts {
            let visible = range.start - source;
            if at >= display && at <= display + visible {
                consider(source + at - display);
            }
            display += visible;
            if *cut == Cut::Divider {
                if at == display {
                    consider(range.start);
                }
                display += DIVIDER.len();
                if at == display {
                    consider(range.end);
                }
            } else if at == display {
                for p in range.start..=range.end {
                    consider(p);
                }
            }
            source = range.end;
        }
        if at >= display && at <= display + body - source {
            consider(source + at - display);
        }
        found
    }
}

/// A line's text without its ending.
pub(crate) fn trimmed(text: &str) -> &str {
    match text.strip_suffix('\n') {
        Some(text) => text.strip_suffix('\r').unwrap_or(text),
        None => text,
    }
}
