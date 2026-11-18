//! Literal cases for the core. The five properties are in `properties.rs`.
mod blocks;
mod clipboard;
mod commands;
mod commits;
mod display_text;
mod external;
mod fences;
mod find;
mod front_matter;
mod images;
mod inline;
mod input;
mod lists;
mod paired_typing;
mod projection;
mod properties;
mod quick_open;
mod replacing;
mod tables;
mod typing;
mod wikilinks;

use super::Engine;
use crate::{Affinity, DisplayOffset, DisplayRange, InputAction, SourceEdit};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

fn ok(_: &SourceEdit) -> Result<(), String> {
    Ok(())
}

fn typed(engine: &mut Engine, text: &str) {
    let at = engine.selection();
    engine
        .replace(engine.revision(), at, text, InputAction::Typing, &mut ok)
        .unwrap();
}

fn select(engine: &mut Engine, start: usize, end: usize, affinity: Affinity) {
    engine
        .select_with_affinity(engine.revision(), range(start, end), affinity)
        .unwrap();
}

/// The note without its marks, and the marked source range.
fn unmark_selection(marked: &str, marks: &[char; 3]) -> (String, std::ops::Range<usize>) {
    let mut text = String::new();
    let (mut start, mut end) = (None, None);
    for ch in marked.chars() {
        if ch == marks[0] {
            start = Some(text.len());
            end = Some(text.len());
        } else if ch == marks[1] {
            start = Some(text.len());
        } else if ch == marks[2] {
            end = Some(text.len());
        } else {
            text.push(ch);
        }
    }
    let start = start.expect("a selection mark");
    (text, start..end.expect("a selection end"))
}

/// Select source `selection`, on the side of hidden text it names.
fn select_source_range(engine: &mut Engine, selection: std::ops::Range<usize>) {
    let display = |at: usize| engine.display_of(at);
    let (start, end) = (display(selection.start), display(selection.end));
    let (lo, _) = engine.source_bounds(start);
    let affinity = if lo == selection.start {
        Affinity::Backward
    } else {
        Affinity::Forward
    };
    select(engine, start, end, affinity);
}
