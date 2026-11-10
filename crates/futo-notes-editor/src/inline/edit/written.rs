//! Escapes the engine itself wrote while a run was typed (`&#35;` for a lone
//! `#` at a line start, `&#32;&#35;` for a heading's would-be closer) are
//! needed only while the text could read as other syntax. Planning the next
//! input that continues the run tries those pieces as literal text; the
//! candidate is kept only when the parser verifies it and nothing but that
//! run and the input changed.
use super::Piece;
use crate::inline::spelling::PieceOrigin;
use std::cell::RefCell;
use std::ops::Range;

/// Characters whose escape can matter beyond the row the planner verifies:
/// table cells, link reference definitions, raw HTML blocks, and escapes
/// themselves. Their escapes stay.
const BLOCK_WIDE: [char; 8] = ['|', '[', ']', '<', '&', '\\', '!', ':'];

thread_local! {
    static WRITTEN: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// While held, inputs planned at the end of `run` (the exact source bytes the
/// engine wrote just before the caret) may respell its escapes literally. The
/// run is thread-wide only while this session plans: it is suspended around
/// every call to the host.
pub(crate) struct EngineWritten(Option<String>);

impl EngineWritten {
    pub(crate) fn set(run: String) -> Self {
        Self(WRITTEN.with(|slot| slot.replace(Some(run))))
    }

    /// No run is held until the guard drops. The host's acceptance callback
    /// runs under this: an input it makes into another session on this
    /// thread must never see this session's run.
    pub(crate) fn suspend() -> Self {
        Self(WRITTEN.with(|slot| slot.take()))
    }
}

impl Drop for EngineWritten {
    fn drop(&mut self) {
        WRITTEN.with(|slot| *slot.borrow_mut() = self.0.take());
    }
}

/// The source window range the run occupies and its literal spelling.
pub(super) struct Unescaped {
    run: Range<usize>,
    literal: String,
}

/// Respells the held run's escapes when the pieces just before the input are
/// exactly that run, read unchanged from the source window, and the input is
/// `plain` text that does not start with whitespace (which could turn a
/// marker live).
pub(super) fn unescape(before: &mut [Piece], inserted: &str, plain: bool) -> Option<Unescaped> {
    if !plain || !inserted.starts_with(|ch: char| !ch.is_whitespace()) {
        return None;
    }
    let run = WRITTEN.with(|slot| slot.borrow().clone())?;
    let (mut at, mut len) = (before.len(), 0);
    while len < run.len() {
        at = at.checked_sub(1)?;
        len += before[at].raw.len();
    }
    let pieces = &before[at..];
    let mut source: Option<Range<usize>> = None;
    for piece in pieces.iter() {
        let Some(PieceOrigin::Source(range)) = &piece.origin else {
            return None;
        };
        if range.len() != piece.raw.len()
            || source
                .as_ref()
                .is_some_and(|source| source.end != range.start)
            || piece.guard.is_some()
            || piece.literal_url.is_some()
            || piece.definition.is_some()
            || piece.physical_prefix
            || piece.trailing
            || piece.display.contains(['\r', '\n'])
        {
            return None;
        }
        source = Some(source.map_or(range.clone(), |source| source.start..range.end));
    }
    let raw: String = pieces.iter().map(|piece| piece.raw.as_str()).collect();
    if raw != run {
        return None;
    }
    // Whitespace leading a line is escaped so other readers keep it.
    let mut text = before[..at]
        .iter()
        .rev()
        .map(|piece| piece.display.as_str())
        .take_while(|display| !display.contains(['\r', '\n']))
        .any(|display| !display.trim().is_empty());
    let mut changed = false;
    for piece in &mut before[at..] {
        text |= !piece.display.trim().is_empty();
        if text
            && piece.raw != piece.display
            && !piece.display.contains(BLOCK_WIDE)
            && decode(&piece.raw).as_deref() == Some(&piece.display)
        {
            piece.raw.clone_from(&piece.display);
            changed = true;
        }
    }
    changed.then(|| Unescaped {
        run: source.unwrap(),
        literal: before[at..]
            .iter()
            .map(|piece| piece.raw.as_str())
            .collect(),
    })
}

/// Whether `output` kept the window outside the run and the input, the run
/// as literal text, and the input without escapes of its own: one the input
/// needs keeps the run's.
pub(super) fn held(unescaped: &Unescaped, raw: &str, output: &str) -> bool {
    let (head, tail) = (&raw[..unescaped.run.start], &raw[unescaped.run.end..]);
    let input = head.len() + unescaped.literal.len();
    output.len() >= input + tail.len()
        && output.starts_with(head)
        && output[head.len()..].starts_with(&unescaped.literal)
        && output.ends_with(tail)
        && output
            .get(input..output.len() - tail.len())
            .is_some_and(|input| !input.contains("&#") && !input.contains('\\'))
}

/// Decodes decimal or hex character references and backslash escapes of
/// ASCII punctuation; `None` when anything else is spelled.
fn decode(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(ch) = rest.chars().next() {
        if let Some(tail) = rest.strip_prefix("&#") {
            let end = tail.find(';')?;
            let code = match tail[..end].strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => tail[..end].parse().ok()?,
            };
            out.push(char::from_u32(code)?);
            rest = &tail[end + 1..];
        } else if let Some(tail) = rest.strip_prefix('\\') {
            let escaped = tail.chars().next().filter(char::is_ascii_punctuation)?;
            out.push(escaped);
            rest = &tail[1..];
        } else if ch == '&' {
            return None;
        } else {
            out.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
    }
    Some(out)
}
