//! A history step on lines the outside change left alone: a line break
//! between the two is a hard boundary, so the step rebases by position and
//! needs no merge.
use similar::{capture_diff_slices, Algorithm, DiffOp};
use std::ops::Range;

/// The step replacing `range` of `old` with `to`, applied to `new` (`old`
/// with the outside change), and where the step starts there: `None` when
/// the outside change shares a line with the step, writes lines at the line
/// break a step of whole lines stands on, or could have been read as
/// changing other lines than the ones it did.
pub(super) fn on_other_lines(
    old: &str,
    new: &str,
    range: Range<usize>,
    to: &str,
) -> Option<(String, usize)> {
    let (mut start, mut from, mut to) = (range.start, old[range].to_owned(), to.to_owned());
    // Only what the step changes counts: bytes it keeps at either end are
    // not part of it, and a line break typed or deleted at a line's end is
    // the same edit at the next line's start, where it stands on whole lines.
    let kept_start = shared(from.chars().zip(to.chars()));
    from.drain(..kept_start);
    to.drain(..kept_start);
    let kept_end = shared(from.chars().rev().zip(to.chars().rev()));
    from.truncate(from.len() - kept_end);
    to.truncate(to.len() - kept_end);
    let mut moved = kept_start;
    start += kept_start;
    while from.is_empty() != to.is_empty() && !starts_line(old, start) {
        let end = start + from.len();
        let moving = if from.is_empty() { &mut to } else { &mut from };
        let Some(first) = moving.chars().next() else {
            break;
        };
        if !old[end..].starts_with(first) {
            break;
        }
        moving.remove(0);
        moving.push(first);
        start += first.len_utf8();
        moved += first.len_utf8();
    }
    let end = start + from.len();
    // A last line without a line ending is whole too.
    let whole =
        starts_line(old, start) && (end == old.len() || (ends_line(&from) && ends_line(&to)));
    let line_of = |at: usize| old[..at].matches('\n').count();
    let lines =
        |text: &str| -> Vec<String> { text.split_inclusive('\n').map(str::to_owned).collect() };
    let (old_lines, new_lines) = (lines(old), lines(new));
    let first = line_of(start);
    let reaches_end = end == old.len();
    let last = match reaches_end {
        true => old_lines.len(),
        false => line_of(end) + usize::from(!whole),
    };
    let forward = placed(&old_lines, &new_lines, first, last)?;
    // A step that runs to the note's end keeps it there: nothing written after.
    if reaches_end && first < last && forward + last - first != new_lines.len() {
        return None;
    }
    let reversed = |lines: &[String]| lines.iter().rev().cloned().collect::<Vec<_>>();
    let (count, new_count) = (old_lines.len(), new_lines.len());
    let mirrored = placed(
        &reversed(&old_lines),
        &reversed(&new_lines),
        count - last,
        count - first,
    )?;
    // Equal lines can make a diff choose between alignments; the step's
    // place stands only when both directions agree on it.
    if new_count - mirrored - (last - first) != forward {
        return None;
    }
    let line_start =
        |lines: &[String], line: usize| -> usize { lines[..line].iter().map(String::len).sum() };
    let at = line_start(&new_lines, forward) + start - line_start(&old_lines, first);
    // Between lines, the line break the step stands on must still be there.
    if first == last && !starts_line(new, at) {
        return None;
    }
    let mut next = new.to_owned();
    next.replace_range(at..at + from.len(), &to);
    Some((next, at - moved))
}

/// The bytes two texts share, read through `pairs` of their characters.
fn shared(pairs: impl Iterator<Item = (char, char)>) -> usize {
    pairs
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a.len_utf8())
        .sum()
}

fn starts_line(text: &str, at: usize) -> bool {
    at == 0 || text.as_bytes()[at - 1] == b'\n'
}

fn ends_line(text: &str) -> bool {
    text.is_empty() || text.ends_with('\n')
}

/// Where old lines `first..last` stand in the new lines, when the change
/// between them keeps those lines; for no lines, where the line break
/// `first` stands, when the change neither rewrites across it nor writes
/// lines at it.
fn placed(old: &[String], new: &[String], first: usize, last: usize) -> Option<usize> {
    let mut found = None;
    for change in capture_diff_slices(Algorithm::Myers, old, new) {
        let (before, after) = (change.old_range(), change.new_range());
        let equal = matches!(change, DiffOp::Equal { .. });
        if first < last {
            if equal && before.start <= first && last <= before.end {
                return Some(after.start + first - before.start);
            }
            continue;
        }
        let inside = before.start < first && first < before.end;
        let written_here = before.is_empty() && before.start == first;
        if !equal && (inside || written_here) {
            return None;
        }
        if before.start <= first && first <= before.end {
            let offset = if equal || first == before.start {
                first - before.start
            } else {
                after.len()
            };
            found = found.or(Some(after.start + offset));
        }
    }
    if first == last && old.len() == first && found.is_none() {
        return Some(new.len());
    }
    found
}
