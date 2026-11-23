//! A pair character typed at a collapsed caret.
use super::super::super::code_block::CodeBlock;
use super::super::super::command::{Command, Edit};
use super::super::super::line::Entry;
use super::super::super::{read, Engine};
use super::is_escaped_at;
use super::pairs::{Opening, Pair, PairKey};
use crate::lines::{block, FenceRole, Kind, Span, SpanKind};
use crate::{DisplayRange, InputAction};

/// What a pair character typed at a collapsed caret does.
pub(super) enum CaretPairing {
    /// Line `index` is a lone backtick pair the caret ends: it becomes a
    /// code block.
    CodeBlock(usize),
    /// The character makes a code line its block's closing fence.
    ClosingFence(ClosingFence),
    /// A hidden closing marker follows the caret: the caret takes its far
    /// side.
    CrossMarker,
    /// A shown closing half follows the caret: the caret moves past it.
    StepOver,
    /// The caret is past a hidden closing marker already: nothing changes.
    Stay,
    /// The pair's halves around the caret (`pair_command`).
    Pair(&'static Pair),
    Typed,
}

/// A character typed at source `at` that makes code line `index` its
/// block's closing fence, above the block's old closing line `closer`.
pub(super) struct ClosingFence {
    index: usize,
    at: usize,
    closer: usize,
}

/// Where only a line's indent and quote markers stand before byte `local`.
fn at_line_start(body: &str, local: usize) -> bool {
    body[..local]
        .bytes()
        .all(|byte| matches!(byte, b' ' | b'\t' | b'>'))
}

fn is_word_character(character: Option<char>) -> bool {
    character.is_some_and(char::is_alphanumeric)
}

/// The level of the empty pair around byte `local`: as many whole opening
/// halves right before it as closing halves right after it, all shown and
/// the first not escaped. `None` when the text there is no empty pair.
pub(super) fn empty_level(entry: &Entry, pair: &Pair, local: usize) -> Option<usize> {
    let body = entry.body();
    let opening = body[..local]
        .bytes()
        .rev()
        .take_while(|&byte| byte == pair.open.as_bytes()[0])
        .count();
    let closing = body[local..]
        .bytes()
        .take_while(|&byte| byte == pair.close.as_bytes()[0])
        .count();
    let unit = pair.open.len();
    let level = opening / unit;
    let hidden = |offset: usize| entry.view.cuts.iter().any(|(cut, _)| cut.contains(&offset));
    let pair_bytes = local - opening..local + closing;
    let empty = opening == closing
        && opening % unit == 0
        && (1..=pair.levels()).contains(&level)
        && !pair_bytes.clone().any(hidden)
        && !is_escaped_at(body, local - opening);
    empty.then_some(level)
}

/// Line `entry` would read as a divider or a code fence with `text`
/// written at byte `local`, as it does not now (`**|**` alone on a line).
fn pair_makes_block(entry: &Entry, local: usize, text: &str) -> bool {
    let body = entry.body();
    let written = format!("{}{text}{}", &body[..local], &body[local..]);
    let mut carry = entry.carry.clone();
    let kind = block::read_line(&mut carry, &written, 0).kind;
    let block = |kind: &Kind| matches!(kind, Kind::Divider | Kind::Fence { .. });
    block(&kind) && !block(&entry.line.kind)
}

/// Among the spans whose hidden closing marker ends at byte `local`, the
/// one opened first. A `typed` right before its opening marker reads as a
/// longer opener's leftover (`**bold*‸`), so a typed one closes it.
fn reopens(spans: &[&Span], body: &str, typed: &str) -> bool {
    spans
        .iter()
        .min_by_key(|span| span.open.start)
        .is_some_and(|outer| body[..outer.open.start].ends_with(typed))
}

/// Whether `pair`'s opening rule lets it write a new pair at byte
/// `local` of `body`.
fn may_open(pair: &Pair, body: &str, local: usize) -> bool {
    let previous = body[..local].chars().next_back();
    match pair.opening {
        Opening::Anywhere => true,
        Opening::AfterSpaceOrPunctuation => {
            !at_line_start(body, local)
                && !is_word_character(previous)
                && !body[..local].ends_with(pair.typed)
        }
        Opening::AfterLoneHalf => {
            let Some(rest) = body[..local].strip_suffix(pair.typed) else {
                return false;
            };
            let lone = rest.len();
            !rest.ends_with(pair.typed)
                && !is_word_character(rest.chars().next_back())
                && !is_escaped_at(body, lone)
        }
    }
}

/// What a pair writes at the caret: the rest of its opening half (after
/// the lone half `AfterLoneHalf` needs) and its closing half.
fn pair_text(pair: &Pair) -> String {
    let open = match pair.opening {
        Opening::AfterLoneHalf => &pair.open[pair.typed.len()..],
        _ => pair.open,
    };
    format!("{open}{}", pair.close)
}

/// The text around a collapsed caret that the rules read.
struct Around<'a> {
    entry: &'a Entry,
    /// The caret, in bytes of the line.
    local: usize,
    pair: &'static Pair,
    typed: &'static str,
    /// The pair's opening character was typed, not its closing one.
    opens: bool,
    /// No hidden syntax follows the caret at its display offset.
    shown: bool,
    /// The caret line's start and where the source showing at the caret's
    /// display offset starts, in the note.
    line_start: usize,
    hidden_from: usize,
}

/// A `*`, `~`, `[` or `]` beside hidden marks: past a closing marker of its
/// format nothing is written (unless it closes a longer opener's
/// leftover); beside any other mark, or inside its own format, where a pair
/// would read as a hidden opener the caret cannot stand in, it is typed.
/// `None` elsewhere.
fn beside_marks(around: &Around) -> Option<CaretPairing> {
    let Around { entry, local, .. } = *around;
    let passed: Vec<&Span> = entry
        .spans
        .iter()
        .filter(|span| around.pair.closes.contains(&span.kind) && !span.close.is_empty())
        .filter(|span| {
            span.close.end == local && around.hidden_from <= around.line_start + span.close.start
        })
        .collect();
    if !passed.is_empty() {
        if reopens(&passed, entry.body(), around.typed) {
            return Some(CaretPairing::Typed);
        }
        return Some(CaretPairing::Stay);
    }
    let inside_format = entry.spans.iter().any(|span| {
        around.pair.closes.contains(&span.kind)
            && span.open.end <= local
            && local < span.close.start
    });
    let beside_mark = inside_format
        || entry.spans.iter().any(|span| {
            [&span.open, &span.close]
                .iter()
                .any(|mark| !mark.is_empty() && (mark.start == local || mark.end == local))
        });
    beside_mark.then_some(CaretPairing::Typed)
}

/// In shown text: an empty pair grows, a shown closing half is stepped
/// over, and a new pair is written where its opening rule allows.
fn pairing_in_text(around: &Around) -> CaretPairing {
    let Around {
        entry, local, pair, ..
    } = *around;
    let body = entry.body();
    let opens = around.opens;
    if let Some(level) = empty_level(entry, pair, local).filter(|_| opens && pair.grows_to > 0) {
        if level < pair.grows_to && !pair_makes_block(entry, local, &pair_text(pair)) {
            return CaretPairing::Pair(pair);
        }
        return CaretPairing::Typed;
    }
    let steps = !opens || pair.closing().is_none();
    if steps && around.shown && body[local..].starts_with(around.typed) {
        return CaretPairing::StepOver;
    }
    if !opens || is_escaped_at(body, local) || !may_open(pair, body, local) {
        return CaretPairing::Typed;
    }
    if pair_makes_block(entry, local, &pair_text(pair)) {
        return CaretPairing::Typed;
    }
    CaretPairing::Pair(pair)
}

impl Engine {
    pub(super) fn caret_pairing(&self, key: &PairKey, range: DisplayRange) -> CaretPairing {
        let at = self.input_at(range);
        let (index, before) = read::line_at(&self.store, at);
        let entry = self.store.get(index);
        let local = at - before.source;
        if let Some(closer) = self.closes_block(index, local, key) {
            return CaretPairing::ClosingFence(ClosingFence { index, at, closer });
        }
        if matches!(entry.line.kind, Kind::Fence { .. } | Kind::FrontMatter(_)) {
            return CaretPairing::Typed;
        }
        let body = entry.body();
        let (pair, typed) = match key {
            PairKey::Open(pair) => (*pair, pair.typed),
            PairKey::Close(pair) => (*pair, pair.close),
        };
        let lone_pair = pair.is_backtick()
            && matches!(entry.line.kind, Kind::Plain { .. })
            && entry.line.quote == 0
            && local == body.len()
            && body.trim_start_matches([' ', '\t']) == "``";
        if lone_pair {
            return CaretPairing::CodeBlock(index);
        }
        let (low, shown_end) = self.source_bounds(range.start.0);
        let markers = || {
            entry
                .spans
                .iter()
                .filter(|span| pair.closes.contains(&span.kind) && !span.close.is_empty())
        };
        let at_marker = |span: &Span| {
            span.close.start == local || (pair.is_backtick() && span.open.start == local)
        };
        if markers().any(at_marker) {
            if at < shown_end {
                return CaretPairing::CrossMarker;
            }
            return CaretPairing::Typed;
        }
        let in_code = entry.spans.iter().any(|span| {
            span.kind == SpanKind::Code && span.open.end <= local && local <= span.close.start
        });
        if in_code || self.formats.is_some() {
            return CaretPairing::Typed;
        }
        let around = Around {
            entry,
            local,
            pair,
            typed,
            opens: matches!(key, PairKey::Open(_)),
            shown: at == shown_end,
            line_start: before.source,
            hidden_from: low,
        };
        if !pair.is_backtick() {
            if let Some(pairing) = beside_marks(&around) {
                return pairing;
            }
        }
        pairing_in_text(&around)
    }

    /// The closing line of code line `index`'s block when the character
    /// `key` types at byte `local` makes the line close the block instead:
    /// that old closing line would then open a block of the text below.
    fn closes_block(&self, index: usize, local: usize, key: &PairKey) -> Option<usize> {
        let entry = self.line(index);
        let Kind::Fence {
            role: FenceRole::Code,
            ..
        } = entry.line.kind
        else {
            return None;
        };
        let typed = match key {
            PairKey::Open(pair) => pair.typed,
            PairKey::Close(pair) => pair.close,
        };
        let body = entry.body();
        let written = format!("{}{typed}{}", &body[..local], &body[local..]);
        let read = block::read_line(&mut entry.carry.clone(), &written, 0);
        let closes = matches!(
            read.kind,
            Kind::Fence {
                role: FenceRole::Close,
                ..
            }
        );
        closes
            .then(|| CodeBlock::holding(&self.store, index).closer)
            .flatten()
    }

    /// `typed` written where it closes the block (`fence`), and the block's
    /// old closing line removed with its line break, so it opens no block of
    /// the text below; the caret after `typed`.
    pub(super) fn closing_fence_command(&self, fence: &ClosingFence, typed: &str) -> Command {
        let ClosingFence { index, at, closer } = *fence;
        let removed = if closer + 1 < self.line_count() {
            self.line_start(closer)..self.line_start(closer + 1)
        } else {
            let above = closer - 1;
            self.line_start(above) + self.line(above).body_len()
                ..self.line_start(closer) + self.line(closer).body_len()
        };
        let caret = at + typed.len();
        Command::new(
            vec![Edit::insert(at, typed), Edit::new(removed, "")],
            index..closer + 1,
            caret..caret,
        )
    }

    /// `pair` typed at the caret as typing writes it, with the caret before
    /// its closing half. `None` when typing would not leave the caret right
    /// after it.
    pub(super) fn pair_command(&self, pair: &Pair, range: DisplayRange) -> Option<Command> {
        let text = pair_text(pair);
        let plan = self.plan_input(range, &text, InputAction::Typing);
        let written = plan.caret.checked_sub(plan.range.start)?;
        if written < text.len() || plan.inserted.get(written - text.len()..written) != Some(&text) {
            return None;
        }
        let first = self.line_of(plan.range.start);
        let last = self.line_of(plan.range.end);
        let caret = plan.caret - pair.close.len();
        let mut command = Command::new(
            vec![Edit::new(plan.range, plan.inserted)],
            first..last + 1,
            caret..caret,
        );
        command.typed = true;
        Some(command)
    }

    /// Line `index` (a lone pair after its indent) as an empty block: an
    /// opening fence and a closing fence at the same indent, which show as
    /// one empty code line; the caret at the opening fence's end, where
    /// letters write its language.
    pub(super) fn lone_pair_block(&self, index: usize) -> Command {
        let start = self.line_start(index);
        let body = self.line(index).body();
        let indent = &body[..body.len() - "``".len()];
        let ending = self.empty_line_ending(index);
        let text = format!("{indent}```{ending}{indent}```");
        let caret = start + indent.len() + "```".len();
        let mut command = Command::new(
            vec![Edit::new(start..start + body.len(), text)],
            index..index + 1,
            caret..caret,
        );
        command.typed = true;
        command
    }
}
