//! Exact parser-owned container prefix spelling; never accepts body Markdown.
use super::*;
use std::collections::BTreeMap;
use std::ops::Range;

pub(super) struct OwnedPrefixShift {
    pub start: usize,
    pub item: Range<usize>,
    pub quote: usize,
    pub delta: isize,
}

pub(super) struct PhysicalPrefixShift {
    pub prefix: crate::inline::blocks::SourcePrefix,
    pub deltas: BTreeMap<usize, isize>,
}

impl EditorSession {
    /// Normalize canonical item ends and visit each affected physical prefix
    /// once, regardless of how many changed ancestors own it.
    pub(super) fn owned_prefix_shifts(
        &self,
        spans: Vec<OwnedPrefixShift>,
    ) -> Result<Vec<PhysicalPrefixShift>, EditorError> {
        let mut plan = Vec::new();
        let mut events = Vec::new();
        for OwnedPrefixShift {
            start: at,
            item,
            quote,
            delta,
        } in spans
        {
            crate::inline::visit_container();
            // A parser item may end in the following line's quote prefix.
            // Normalize its end with canonical ownership, not byte indentation.
            let end = if item.end >= self.source.len_bytes() {
                self.source.len_bytes()
            } else {
                let line = self.source.line_to_byte(self.source.byte_to_line(item.end));
                if line == item.end {
                    item.end
                } else {
                    self.projection
                        .source_prefix_at(line)
                        .map_or(line, |prefix| {
                            if prefix.list.as_ref().is_some_and(|list| {
                                item.start <= list.marker.start && list.marker.start < item.end
                            }) {
                                prefix.source.end
                            } else {
                                line
                            }
                        })
                }
            };
            if at < end {
                events.push((at, quote, delta));
                events.push((end, quote, -delta));
            }
        }
        events.sort_by_key(|event| {
            crate::inline::visit_container();
            event.0
        });
        let mut next = 0;
        let mut at = events.first().map_or(0, |event| event.0);
        let mut active: BTreeMap<usize, isize> = BTreeMap::new();
        while next < events.len() || !active.is_empty() {
            while let Some(&(_, quote, delta)) = events.get(next).filter(|event| event.0 <= at) {
                crate::inline::visit_container();
                let value = active.entry(quote).or_default();
                *value += delta;
                if *value == 0 {
                    active.remove(&quote);
                }
                next += 1;
            }
            if active.is_empty() {
                if let Some(event) = events.get(next) {
                    at = event.0;
                    continue;
                }
                break;
            }
            crate::inline::visit_container();
            let prefix = self
                .projection
                .source_prefix_at(at)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let following = prefix.source.end;
            if following <= at {
                return Err(EditorError::UnrepresentableFormat);
            }
            if prefix.list.is_some() {
                let shifts = active
                    .iter()
                    .map(|(&quote, &delta)| {
                        crate::inline::visit_container();
                        (quote, delta)
                    })
                    .collect();
                plan.push(PhysicalPrefixShift {
                    prefix,
                    deltas: shifts,
                });
            }
            at = following;
        }
        Ok(plan)
    }
}

/// Only enclosing quote prefixes precede a list's indentation. Quote markers
/// inside the item are shifted with its body, never mistaken for its parent.
pub(super) fn quote_prefix_end(line: &str, depth: usize) -> usize {
    let mut at = 0;
    for _ in 0..depth {
        let spaces = line[at..].bytes().take_while(|&b| b == b' ').count().min(3);
        if line.as_bytes().get(at + spaces) != Some(&b'>') {
            break;
        }
        at += spaces + 1;
        if matches!(line.as_bytes().get(at), Some(b' ' | b'\t')) {
            at += 1;
        }
    }
    at
}

pub(super) fn shift_prefix(prefix: &str, quote: usize, delta: isize, preserve: bool) -> String {
    if preserve || delta == 0 {
        return prefix.to_owned();
    }
    let end = quote_prefix_end(prefix, quote);
    let base = crate::inline::columns(&prefix[..end], 0);
    let mut result = prefix[..end].to_owned();
    let tail = &prefix[end..];
    if delta > 0 {
        result.push_str(&" ".repeat(delta as usize));
        result.push_str(tail);
    } else {
        let width = delta.unsigned_abs();
        let mut column = base;
        let mut bytes = 0;
        for byte in tail.bytes() {
            if column - base >= width || !matches!(byte, b' ' | b'\t') {
                break;
            }
            column = crate::inline::columns(&tail[bytes..bytes + 1], column);
            bytes += 1;
        }
        result.push_str(&" ".repeat((column - base).saturating_sub(width)));
        result.push_str(&tail[bytes..]);
    }
    result
}

/// Spell all changed container columns in one pass over a physical prefix.
/// Canonical attribution supplies quote count and width deltas; body bytes are
/// never accepted here. Keep authored tabs when they still land at the target.
pub(super) fn shift_prefixes(
    prefix: &str,
    quote_depth: usize,
    shifts: &std::collections::BTreeMap<usize, isize>,
    preserve: bool,
) -> Result<String, super::EditorError> {
    if preserve {
        return Ok(prefix.to_owned());
    }
    let mut result = String::with_capacity(prefix.len());
    let mut at = 0;
    let mut depth = 0;
    let mut old_column = 0usize;
    let mut new_column = 0usize;
    let mut delta = shifts.get(&0).copied().unwrap_or(0);
    loop {
        let start = at;
        while matches!(prefix.as_bytes().get(at), Some(b' ' | b'\t')) {
            crate::inline::visit_container();
            at += 1;
        }
        let whitespace = &prefix[start..at];
        old_column = crate::inline::columns(whitespace, old_column);
        let target = old_column
            .checked_add_signed(delta)
            .filter(|&target| target >= new_column)
            .ok_or(super::EditorError::UnrepresentableFormat)?;
        if crate::inline::columns(whitespace, new_column) == target {
            result.push_str(whitespace);
        } else {
            result.extend(std::iter::repeat_n(' ', target - new_column));
        }
        new_column = target;
        let Some(ch) = prefix[at..].chars().next() else {
            break;
        };
        crate::inline::visit_container();
        result.push(ch);
        at += ch.len_utf8();
        old_column += ch.len_utf8();
        new_column += ch.len_utf8();
        if ch == '>' && depth < quote_depth {
            depth += 1;
            delta = delta
                .checked_add(shifts.get(&depth).copied().unwrap_or(0))
                .ok_or(super::EditorError::UnrepresentableFormat)?;
        }
    }
    if shifts.keys().any(|&quote| {
        crate::inline::visit_container();
        quote > depth
    }) {
        return Err(super::EditorError::UnrepresentableFormat);
    }
    Ok(result)
}

/// Quote count is parser attribution; a source prefix contains no body text.
/// Container padding before a quote may exceed three columns after wide lists.
pub(super) fn canonical_quote_end(prefix: &str, depth: usize) -> Option<usize> {
    let mut at = 0;
    for _ in 0..depth {
        let next = prefix[at..].find('>')?;
        for _ in 0..=next {
            crate::inline::visit_container();
        }
        at += next + 1;
        if matches!(prefix.as_bytes().get(at), Some(b' ' | b'\t')) {
            at += 1;
        }
    }
    Some(at)
}
