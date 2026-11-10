//! Repairs for a replacement whose selection crosses a code block's frame.
//! Text after the selection joins the line the selection began on, as it does
//! across any block boundary, and the code lines left stay code. The planner
//! tries these only for input it refused without them, and accepts the result
//! only when it shows exactly the replaced display and every line outside the
//! selection keeps its block.
use super::{Piece, PieceOrigin};
use crate::inline::fences::Fence;
use crate::inline::references::{References, Winner};
use crate::inline::row::Row;
use crate::EditorError;
use std::ops::Range;

fn hidden_piece(raw: String, trailing: bool) -> Piece {
    Piece {
        guard: None,
        physical_prefix: false,
        literal_url: None,
        raw,
        origin: None,
        timing: false,
        display: String::new(),
        spans: Vec::new(),
        trailing,
        definition: None,
    }
}

fn starts_at(pieces: &[Piece], at: usize) -> bool {
    pieces
        .iter()
        .any(|piece| matches!(&piece.origin, Some(PieceOrigin::Source(r)) if r.start == at))
}

fn within(piece: &Piece, range: &Range<usize>) -> bool {
    matches!(&piece.origin, Some(PieceOrigin::Source(r)) if range.start <= r.start && r.end <= range.end)
}

/// Gives each fence whose opener or closer the cut dropped (with the other
/// kept) its missing end again, where the surviving lines now begin or end.
/// A fence the replacement owned whole is gone from both lists and is left;
/// one with no closer (open to the end of the note) has only an opener to
/// lose. `ends_note` says the context ends the note, whose final line ending
/// is hidden after a closing fence and shown after anything else.
pub(super) fn rebalance(
    frames: &[Fence],
    raw: &str,
    before: &mut Vec<Piece>,
    after: &mut Vec<Piece>,
    selecting: bool,
    ends_note: bool,
) {
    // Fences that lost their opener first: the lines they leave may be the
    // ones a fence that lost its closer then closes after.
    let mut lost = Vec::new();
    for frame in frames {
        // A closer outside this context is never cut; neither is an opener.
        let closer = frame.closer.clone();
        if closer.as_ref().is_some_and(|closer| closer.end > raw.len()) {
            continue;
        }
        let opener_in_context = raw
            .get(frame.opener.clone())
            .is_some_and(|text| !text.is_empty() && text.bytes().all(|byte| byte == frame.marker));
        // The closer's line: where it starts, and where its text and ending end.
        let line = closer.as_ref().map(|closer| {
            let start = raw[..closer.start].rfind('\n').map_or(0, |at| at + 1);
            let eol = raw[closer.start..]
                .find('\n')
                .map_or(raw.len(), |at| closer.start + at);
            let text_end = eol - usize::from(raw[..eol].ends_with('\r'));
            (start, text_end, raw.len().min(eol + 1))
        });
        // A selection that begins where the body ends takes the closer
        // line's ending with it, so the frame's hidden tail goes too.
        if let (true, Some((_, text_end, _))) = (selecting, line) {
            let tail = frame.body.end..text_end;
            while before.last().is_some_and(|piece| within(piece, &tail)) {
                before.pop();
            }
        }
        let kept = |at: usize| starts_at(before, at) || starts_at(after, at);
        let opener_kept = !opener_in_context || kept(frame.opener.start);
        let closer_kept = closer.as_ref().is_none_or(|closer| kept(closer.start));
        if opener_kept != closer_kept {
            lost.push((frame, line, opener_kept));
        }
    }
    lost.sort_by_key(|&(_, _, opener_kept)| opener_kept);
    for (frame, line, opener_kept) in lost {
        let Some((line_start, text_end, line_end)) = line else {
            reopen(frame, raw, after, None, false);
            continue;
        };
        if opener_kept {
            // The closer went with the selection: it closes the line the
            // surviving text ended up on, before that line's own ending.
            let ending = raw
                .get(frame.separator.clone())
                .filter(|ending| !ending.is_empty())
                .unwrap_or("\n");
            let first_break = after.iter().position(|piece| piece.raw.contains('\n'));
            let mut at = first_break.unwrap_or(after.len());
            if at > 0 && at < after.len() && after[at - 1].raw.ends_with('\r') {
                at -= 1;
            }
            let last = first_break.is_some_and(|end| end + 1 == after.len());
            // What joins the code line is code: opaque text, no inline spans.
            for piece in &mut after[..at] {
                piece.spans.clear();
            }
            after.splice(
                at..at,
                [
                    hidden_piece(ending.to_owned(), true),
                    hidden_piece(raw[line_start..text_end].to_owned(), false),
                ],
            );
            if ends_note && last {
                for piece in &mut after[at + 2..] {
                    piece.display.clear();
                }
            }
        } else {
            let gone = frame.body.end..text_end;
            reopen(
                frame,
                raw,
                after,
                Some((gone, text_end..line_end)),
                ends_note,
            );
        }
    }
}

/// The opener went with the selection. Code lines after the first one that
/// survive open the block again, with the lines' own container prefix; when
/// only the end of one line survives it is text, so the frame goes too: its
/// closer line (`frame_and_ending`, when there is one) is removed and its
/// ending shows, unless it is the note's final one (`ends_note`): hidden
/// after the frame, it goes with it rather than show as a new line.
fn reopen(
    frame: &Fence,
    raw: &str,
    after: &mut Vec<Piece>,
    frame_and_ending: Option<(Range<usize>, Range<usize>)>,
    ends_note: bool,
) {
    let next = after
        .iter()
        .position(|piece| within(piece, &frame.body) && piece.raw.ends_with('\n'));
    let Some(next) = next else {
        let (gone, ending) = frame_and_ending.unwrap_or((0..0, frame.separator.clone()));
        let last = ends_note && ending.end == raw.len();
        after.retain(|piece| !within(piece, &gone) && !(last && within(piece, &ending)));
        for piece in after.iter_mut().filter(|piece| within(piece, &ending)) {
            piece.display = piece.raw.clone();
        }
        return;
    };
    let opener_end = raw[frame.opener.start..]
        .find('\n')
        .map_or(raw.len(), |at| frame.opener.start + at + 1);
    let prefix: String = after[next + 1..]
        .iter()
        .take_while(|piece| indent_or_quote(piece))
        .map(|piece| piece.raw.as_str())
        .collect();
    let opener = format!("{prefix}{}", &raw[frame.opener.start..opener_end]);
    after.insert(next + 1, hidden_piece(opener, false));
}

fn indent_or_quote(piece: &Piece) -> bool {
    piece.display.is_empty()
        && !piece.raw.is_empty()
        && piece.raw.chars().all(|ch| matches!(ch, ' ' | '\t' | '>'))
}

thread_local! {
    static RETRY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static REPAIRED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Held while the planner gives a fence back the frame end its cut dropped
/// (`rebalance`) and accepts the result only as `Shown::kept` allows: in its
/// own retry of an input it refused, or for a paste out of code.
pub(crate) struct Repair(bool);

impl Repair {
    pub(crate) fn hold() -> Self {
        Self(RETRY.with(|slot| slot.replace(true)))
    }

    pub(super) fn held() -> bool {
        RETRY.with(std::cell::Cell::get)
    }

    /// `plan`, held (the planner's retry of an input it refused, or its
    /// plan for one under a caller's hold): accepted, it is noted for
    /// `Repaired`.
    pub(super) fn retry<T>(plan: impl Fn() -> Result<T, EditorError>) -> Result<T, EditorError> {
        let _held = Self::hold();
        let planned = plan()?;
        REPAIRED.with(|slot| slot.set(true));
        Ok(planned)
    }
}

impl Drop for Repair {
    fn drop(&mut self) {
        RETRY.with(|slot| slot.set(self.0));
    }
}

/// Watches for an accepted retry (`Repair`), for a key rule that takes the planned
/// result on and must then check its own result the same way (`keeps_blocks`).
pub(crate) struct Repaired(bool);

impl Repaired {
    pub(crate) fn watch() -> Self {
        Self(REPAIRED.with(|slot| slot.replace(false)))
    }

    pub(crate) fn seen(&self) -> bool {
        REPAIRED.with(std::cell::Cell::get)
    }
}

impl Drop for Repaired {
    fn drop(&mut self) {
        REPAIRED.with(|slot| slot.set(self.0 || slot.get()));
    }
}

/// Whether the planner may `Repair::retry` an input over `range`: a
/// selection, outside a retry, with neither end between a CR and its LF
/// (Undo could not select that range again as given).
pub(super) fn may_repair(display: &ropey::Rope, range: crate::DisplayRange) -> bool {
    range.start != range.end
        && !Repair::held()
        && ![range.start.0, range.end.0].into_iter().any(|at| {
            at > 0
                && at < display.len_bytes()
                && display.byte(at - 1) == b'\r'
                && display.byte(at) == b'\n'
        })
}

/// The context's display and reference definitions before the edit, and
/// the display of the input planned into it.
pub(super) struct Shown {
    display: String,
    winners: Vec<Winner>,
    input: String,
}

impl Shown {
    pub(super) fn read(pieces: &[Piece]) -> Self {
        let winners = pieces
            .iter()
            .filter_map(|piece| match (&piece.origin, &piece.definition) {
                (Some(PieceOrigin::Source(range)), Some(key)) => Some(Winner {
                    range: range.clone(),
                    key: key.clone(),
                }),
                _ => None,
            })
            .collect();
        Self {
            display: pieces.iter().map(|piece| piece.display.as_str()).collect(),
            winners,
            input: String::new(),
        }
    }

    pub(super) fn input(&mut self, pieces: &[Piece]) {
        self.input = pieces.iter().map(|piece| piece.display.as_str()).collect();
    }

    /// `keeps_blocks` for the planner's output replacing `raw`, both read as
    /// the candidate is and followed by the lines after the context an item
    /// open at its end could take in (`[output, following]`). Refused
    /// otherwise; the bytes parsed.
    pub(super) fn kept(
        &self,
        raw: &str,
        [output, following]: [&str; 2],
        a: usize,
        z: usize,
        references: &std::sync::Arc<References>,
        winners: &[Winner],
    ) -> Result<usize, EditorError> {
        let new = Row::candidate(&format!("{output}{following}"), references, winners);
        let old = Row::candidate(&format!("{raw}{following}"), references, &self.winners);
        let input = &self.input;
        let shown = old.display.starts_with(&self.display)
            && new.display == format!("{}{input}{}", &old.display[..a], &old.display[z..]);
        if !shown || !kinds_kept(&old, &new, a, z) {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(new.parsed_source_bytes + old.parsed_source_bytes)
    }
}

/// The lines after source `end` that an open list item could take in: blank
/// or indented ones (the context ends at a blank line or the note's end).
pub(super) fn following(source: &ropey::Rope, end: usize) -> String {
    let mut text = String::new();
    for line in source.byte_slice(end..).lines() {
        let line = line.to_string();
        if !line.trim().is_empty() && !line.starts_with([' ', '\t']) {
            break;
        }
        text.push_str(&line);
    }
    text
}

/// Whether `after`, the source `before` became by an input over display
/// `a..z`, shows the old display with that range replaced by one of `inputs`
/// and keeps the block of every nonblank line before the range's first line
/// and after its last (`Kind`). Also the bytes parsed.
pub(crate) fn keeps_blocks(
    before: &str,
    after: &str,
    a: usize,
    z: usize,
    inputs: &[&str],
) -> (bool, usize) {
    let read = |text: &str| {
        let (references, winners, _) = References::scan(text);
        Row::parse_with_references(text, &references, &winners)
    };
    let (old, new) = (read(before), read(after));
    let shown = inputs
        .iter()
        .any(|input| new.display == format!("{}{input}{}", &old.display[..a], &old.display[z..]));
    (
        shown && kinds_kept(&old, &new, a, z),
        old.parsed_source_bytes + new.parsed_source_bytes,
    )
}

/// What a shown line is: code, a heading level, its quote depth and its list
/// nesting.
#[derive(PartialEq)]
struct Kind {
    code: bool,
    heading: u8,
    quote: usize,
    list: Option<usize>,
    in_list: bool,
    html: bool,
}

/// Whether the nonblank lines of `old` before display `a`'s line and after
/// `z`'s keep their `Kind` as the first and last lines of `new`.
fn kinds_kept(old: &Row, new: &Row, a: usize, z: usize) -> bool {
    let (first, last) = (
        old.display[..a].matches('\n').count(),
        old.display[..z].matches('\n').count(),
    );
    let old_lines = shown_lines(old);
    let new_lines = shown_lines(new);
    let before: Vec<_> = old_lines.iter().filter(|line| line.0 < first).collect();
    let after: Vec<_> = old_lines.iter().filter(|line| line.0 > last).collect();
    before.len() + after.len() <= new_lines.len()
        && before
            .iter()
            .zip(&new_lines)
            .all(|(old, new)| old.1 == new.1)
        && after
            .iter()
            .rev()
            .zip(new_lines.iter().rev())
            .all(|(old, new)| old.1 == new.1)
}

/// Each nonblank shown line's index and `Kind`, from the block holding its
/// first character.
fn shown_lines(row: &Row) -> Vec<(usize, Kind)> {
    let mut lines = Vec::new();
    let mut at = 0;
    for (index, text) in row.display.split('\n').enumerate() {
        let start = at;
        at += text.len() + 1;
        if text.trim().is_empty() {
            continue;
        }
        let segment = row
            .segments
            .partition_point(|segment| segment.display.end <= start);
        let Some(segment) = row.segments.get(segment) else {
            continue;
        };
        let source = segment.source.start
            + if segment.identity {
                start.saturating_sub(segment.display.start)
            } else {
                0
            };
        let block = row
            .blocks
            .partition_point(|block| block.source.end <= source);
        if let Some(block) = row.blocks.get(block) {
            lines.push((
                index,
                Kind {
                    code: block.code,
                    heading: block.heading,
                    quote: block.quote_depth,
                    list: block.list.as_ref().map(|list| list.depth),
                    in_list: block.in_list,
                    html: block.html,
                },
            ));
        }
    }
    lines
}
