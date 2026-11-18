//! What Enter in a list item may rewrite outside its reach (lists.md,
//! list-indent.md): an empty item's spaces, which go with its marker, and
//! the numbers renumbering bumps. Enter over lines renumbers nothing.
use super::*;
use std::ops::Range;

/// A numbered item's number and delimiter.
fn ordinal(engine: &Engine, index: usize) -> Option<(u128, u8)> {
    let entry = engine.line(index);
    let Kind::List {
        ordered: true,
        text,
        ..
    } = &entry.line.kind
    else {
        return None;
    };
    let number = entry.body()[text.start..text.end - 1].parse().ok()?;
    Some((number, entry.body().as_bytes()[text.end - 1]))
}

/// Where a walk for bumped numbers starts: after line `index`, along the
/// items at `indent` and `quote` with `delimiter`, counting on from
/// `number`.
struct Walk {
    index: usize,
    indent: usize,
    quote: usize,
    delimiter: u8,
    number: u128,
}

/// The digits of each item on `walk` that counts on in sequence, passing
/// over lines indented further and code, up to the first other line.
fn bumped(engine: &Engine, walk: Walk) -> Vec<Range<usize>> {
    let mut counted = walk.number;
    let mut digits = Vec::new();
    for later in walk.index + 1..engine.store.len() {
        let line = &engine.line(later).line;
        if line.quote != walk.quote {
            break;
        }
        match &line.kind {
            Kind::List { indent, text, .. } if *indent == walk.indent => {
                if ordinal(engine, later) != Some((counted + 1, walk.delimiter)) {
                    break;
                }
                counted += 1;
                let start = engine.line_start(later);
                digits.push(start + text.start..start + text.end - 1);
            }
            Kind::List { indent, .. } | Kind::Plain { indent } if *indent > walk.indent => {}
            Kind::Fence {
                role: FenceRole::Open,
                indent,
                ..
            } if *indent > walk.indent => {}
            Kind::Fence {
                role: FenceRole::Code | FenceRole::Close,
                ..
            } => {}
            _ => break,
        }
    }
    digits
}

/// The item Outdent puts line `index` beside: the nearest list item above
/// it at its quote depth with less indent, past blank lines, lines indented
/// further and code.
fn parent(engine: &Engine, index: usize, indent: usize) -> Option<usize> {
    let quote = engine.line(index).line.quote;
    for above in (0..index).rev() {
        let line = &engine.line(above).line;
        if line.quote != quote {
            return None;
        }
        match line.kind {
            Kind::List { indent: own, .. } if own < indent => return Some(above),
            Kind::Blank | Kind::List { .. } => {}
            Kind::Plain { indent: own } if own > 0 => {}
            Kind::Fence {
                role: FenceRole::Code | FenceRole::Close,
                ..
            } => {}
            Kind::Fence {
                role: FenceRole::Open,
                indent: own,
                ..
            } if own > 0 => {}
            _ => return None,
        }
    }
    None
}

/// The source Enter over `reach` may rewrite besides it.
pub(super) fn enter_rewrites(engine: &Engine, reach: &Range<usize>) -> Vec<Range<usize>> {
    let index = engine.line_of(reach.end);
    if engine.line_of(reach.start) != index {
        return Vec::new();
    }
    let entry = engine.line(index);
    let Kind::List { indent, .. } = entry.line.kind else {
        return Vec::new();
    };
    let start = engine.line_start(index);
    let content = entry.line.content.start;
    let empty = entry.body()[content..].trim_matches([' ', '\t']).is_empty();
    let mut rewrites = Vec::new();
    if empty {
        rewrites.push(start + content..start + entry.body_len());
    }
    let Some((number, delimiter)) = ordinal(engine, index) else {
        return rewrites;
    };
    let walk = |indent: usize, number: u128| Walk {
        index,
        indent,
        quote: entry.line.quote,
        delimiter,
        number,
    };
    // Enter on an empty item with no indent takes it out of the list.
    if empty && indent == 0 {
        return rewrites;
    }
    rewrites.extend(bumped(engine, walk(indent, number)));
    if !empty {
        return rewrites;
    }
    // On an empty indented item Enter is Outdent: the items after it at its
    // new indent count on from the item it now stands beside.
    if let Some(above) = parent(engine, index, indent) {
        let Kind::List { indent: new, .. } = engine.line(above).line.kind else {
            return rewrites;
        };
        let base = match ordinal(engine, above) {
            Some((above_number, above_delimiter)) if above_delimiter == delimiter => above_number,
            _ => number,
        };
        rewrites.extend(bumped(engine, walk(new, base)));
    }
    rewrites
}
