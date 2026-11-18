//! Random edit steps, with properties 2 and 3 checked as they run.
use super::*;

pub(super) fn ok(_: &SourceEdit) -> Result<(), String> {
    Ok(())
}

/// What the history should hold, kept beside the engine.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct State {
    pub(super) source: String,
    selection: DisplayRange,
    affinity: Affinity,
    selected_block: Option<DisplayRange>,
}

pub(super) fn state(engine: &Engine) -> State {
    State {
        source: engine.source_text(),
        selection: engine.selection(),
        affinity: engine.affinity(),
        selected_block: engine.selected_block(),
    }
}

#[derive(Default)]
pub(in crate::engine::tests) struct Model {
    undo: Vec<(State, State)>,
    redo: Vec<(State, State)>,
}

impl Model {
    /// Record an accepted edit that took the engine from `before`.
    pub(super) fn edited(&mut self, engine: &Engine, before: State, groups_before: usize) {
        let after = state(engine);
        if engine.history.undo.len() == groups_before {
            self.undo.last_mut().expect("a joined group").1 = after;
        } else {
            assert_eq!(engine.history.undo.len(), groups_before + 1);
            self.undo.push((before, after));
        }
        self.redo.clear();
    }

    fn edited_twice(&mut self, engine: &Engine, before: State, middle: State) {
        self.undo.push((before, middle.clone()));
        self.undo.push((middle, state(engine)));
        self.redo.clear();
    }
}

/// One random step. Returns a description for failure messages.
pub(in crate::engine::tests) fn step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    match random.below(14) {
        10 | 11 => command_step(engine, model, view, random),
        12 => inline_step(engine, model, view, random),
        13 => super::paired::paired_step(engine, model, view, random),
        0 | 1 => select_step(engine, random),
        2..=4 => type_step(engine, model, view, random),
        5 => delete_step(engine, model, view, random),
        6 => history_step(engine, model, view, random),
        7 => compose_step(engine, model, view, random),
        8 => compose_then_type_step(engine, model, view),
        _ => source_step(engine, model, view, random),
    }
}

/// A random selection.
pub(super) fn select_step(engine: &mut Engine, random: &mut Random) -> String {
    let revision = engine.revision();
    let a = display_offset(engine, random);
    let b = if random.below(2) == 0 {
        a
    } else {
        display_offset(engine, random)
    };
    let affinity = if random.below(2) == 0 {
        Affinity::Backward
    } else {
        Affinity::Forward
    };
    let range = DisplayRange {
        start: DisplayOffset(a.min(b)),
        end: DisplayOffset(a.max(b)),
    };
    engine
        .select_with_affinity(revision, range, affinity)
        .unwrap();
    assert_eq!(engine.revision(), revision);
    format!("select {range:?} {affinity:?}")
}

/// Property 2: typing at the caret.
pub(super) fn type_step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    let revision = engine.revision();
    let before = state(engine);
    let groups = engine.history.undo.len();
    // Property 2: typing at the caret.
    let text = random.pick(TYPED);
    let selection = engine.selection();
    let collapsed = selection.start == selection.end;
    // Carets snap to an image edge; a nonempty range includes any image it touches.
    let stop = engine.outside_images(selection);
    let at = if stop == selection {
        engine.caret_source()
    } else {
        engine.source_bounds(stop.start.0).0
    };
    // Every source offset that shows at the caret's display point, and
    // what the caret carries and shows before typing.
    let bounds = engine.source_bounds(stop.start.0);
    let carried = engine.formats.clone();
    let shown = engine.display_text();
    let empty_line = engine.empty_line(stop.start.0);
    // Typing at a divider's edge writes its own line (display rule 5).
    let beside_divider = engine.beside_divider(at, text).map(|(written, _)| written);
    // Typing on an empty quote line with no space after its `>` writes that
    // space first when the text would otherwise unquote it (display rule 6).
    let quote_space = engine.quote_space(at, text);
    // A selection's edit stays inside the source it spans: from the hidden
    // pieces at its start to those at its end (from 0 over front matter).
    let spanned = {
        let start = if engine.metadata_end().is_some() && stop.start.0 == 0 {
            0
        } else {
            engine.source_span(stop.start.0).0
        };
        start..engine.source_span(stop.end.0).1
    };
    let reach = whole_blocks(engine, &spanned);
    let block_selected = engine.selected_block().is_some();
    let change = engine
        .replace(revision, selection, text, InputAction::Typing, &mut ok)
        .unwrap_or_else(|error| {
            panic!(
                "typing {text:?} refused: {error:?} in {before:?}, pin {:?}, display {:?}",
                engine.pin,
                engine.display_text()
            )
        });
    let Some(change) = change else {
        // Over a selected block, the typed text may be the block's own.
        assert!(
            !collapsed || block_selected,
            "typing {text:?} at a caret changed nothing"
        );
        return format!("type {text:?} over {selection:?}, no change");
    };
    apply_view(view, &change);
    if block_selected {
        typed_over_selected_block(&change.edit, text);
        model.edited(engine, before, groups);
        return format!("type {text:?} over the selected block {selection:?}");
    }
    if !collapsed {
        let edited = change.edit.range.start.0..change.edit.range.end.0;
        assert!(
            reach.start <= edited.start && edited.end <= reach.end,
            "replacing {selection:?} edited {edited:?}, outside {spanned:?} (reach {reach:?})"
        );
    }
    if collapsed {
        let written = match (beside_divider, empty_line) {
            (Some(written), _) => written,
            (None, Some(index)) => format!("{}{text}", empty_line_start(&before.source, index)),
            (None, None) if quote_space => format!(" {text}"),
            (None, None) => text.to_owned(),
        };
        let now = engine.source_text();
        let typed_at = |place: usize| {
            let mut want = before.source.clone();
            want.insert_str(place, &written);
            want
        };
        // The source offsets that show at the caret's display point: typing
        // may land at any of them (after a link's hidden destination, say).
        let places = || {
            std::iter::once(at)
                .chain(bounds.0..=bounds.1)
                .filter(|&place| before.source.is_char_boundary(place))
        };
        let plain = places().any(|place| typed_at(place) == now);
        match &carried {
            // (a) Exactly the typed bytes, at the caret's display point.
            None => assert!(
                plain,
                "typing {text:?} at {at} (shown at {bounds:?}) wrote {now:?}"
            ),
            // (b) Under carried formats: shown exactly as typed, in those
            // formats, and only inline marks written besides.
            Some(formats) if !plain => {
                let mut want = shown.clone();
                want.insert_str(stop.start.0, text);
                let context = format!("typing {text:?} under {formats:?} at {at}");
                assert_eq!(engine.display_text(), want, "{context}");
                let marks_only = places().any(|place| {
                    let (written, typed) = unmarked_difference(&now, &typed_at(place));
                    written == typed
                });
                assert!(
                    marks_only,
                    "{context}: {now:?} writes more than marks besides the typed text"
                );
                super::inline::typed_formats(
                    engine,
                    stop.start.0,
                    text,
                    formats,
                    &typed_at(at),
                    &context,
                );
            }
            Some(_) => {}
        }
    }
    model.edited(engine, before, groups);
    format!("type {text:?} at {selection:?}")
}

/// Where `a` and `b` differ (without the characters they share at either
/// end), each without inline marks. A code span's padding (a space each
/// side, around text that starts or ends with a backtick) is part of its
/// marks; a space on one side only is code text (`` `> ` ``).
fn unmarked_difference(a: &str, b: &str) -> (String, String) {
    let unmarked = |text: &str| {
        let padded = text.contains("` ") && text.contains(" `");
        let text = if padded {
            text.replace("` ", "`").replace(" `", "`")
        } else {
            text.to_owned()
        };
        text.replace(['*', '_', '~', '`'], "")
    };
    let prefix: usize = a
        .chars()
        .zip(b.chars())
        .take_while(|(x, y)| x == y)
        .map(|(x, _)| x.len_utf8())
        .sum();
    let (a, b) = (&a[prefix..], &b[prefix..]);
    let suffix: usize = a
        .chars()
        .rev()
        .zip(b.chars().rev())
        .take_while(|(x, y)| x == y)
        .map(|(x, _)| x.len_utf8())
        .sum();
    (
        unmarked(&a[..a.len() - suffix]),
        unmarked(&b[..b.len() - suffix]),
    )
}

/// Backspace or Delete.
pub(super) fn delete_step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    let revision = engine.revision();
    let before = state(engine);
    let groups = engine.history.undo.len();
    let direction = if random.below(2) == 0 {
        CaretDirection::Backward
    } else {
        CaretDirection::Forward
    };
    if let Some(change) = engine.delete(revision, direction, &mut ok).unwrap() {
        apply_view(view, &change);
        model.edited(engine, before, groups);
    }
    format!("delete {direction:?}")
}

/// Property 3: undo or redo.
pub(super) fn history_step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    let revision = engine.revision();
    // Property 3.
    let redo = random.below(3) == 0;
    let result = if redo {
        engine.redo(revision, &mut ok)
    } else {
        engine.undo(revision, &mut ok)
    }
    .unwrap();
    let (from, to) = if redo {
        (&mut model.redo, &mut model.undo)
    } else {
        (&mut model.undo, &mut model.redo)
    };
    match (result, from.pop()) {
        (Some(change), Some(entry)) => {
            apply_view(view, &change);
            let want = if redo { &entry.1 } else { &entry.0 };
            assert_eq!(&state(engine), want, "redo {redo}");
            to.push(entry);
        }
        (None, None) => {}
        (result, entry) => panic!("history disagrees: {result:?} {entry:?}"),
    }
    if redo { "redo" } else { "undo" }.to_owned()
}

/// Marked text committed or cancelled.
pub(super) fn compose_step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    let revision = engine.revision();
    let before = state(engine);
    let groups = engine.history.undo.len();
    let selection = engine.selection();
    engine.compose(revision, selection, "か").unwrap();
    let text = random.pick(&["かな", "", "x", "か"]);
    if random.below(4) == 0 {
        engine.cancel_composition(revision).unwrap();
        format!("compose then cancel at {selection:?}")
    } else {
        if let Some(change) = engine
            .commit_composition(revision, Some(text), &mut ok)
            .unwrap()
        {
            apply_view(view, &change);
            model.edited(engine, before, groups);
        }
        format!("compose {text:?} at {selection:?}")
    }
}

/// Typing while marked text is pending.
pub(super) fn compose_then_type_step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
) -> String {
    let revision = engine.revision();
    let before = state(engine);
    let selection = engine.selection();
    let marked = engine.compose(revision, selection, "か").unwrap();
    let caret = DisplayOffset(marked.range.start.0 + "か".len());
    let groups_before = engine.history.undo.len();
    let change = engine
        .replace(
            revision,
            DisplayRange {
                start: caret,
                end: caret,
            },
            "!",
            InputAction::Typing,
            &mut ok,
        )
        .unwrap();
    let Some(change) = change else {
        // The marked text and the input put back what was selected.
        assert_eq!(state(engine).source, before.source);
        assert_eq!(engine.history.undo.len(), groups_before);
        return format!("compose then type over {selection:?}, no change");
    };
    apply_view(view, &change);
    if engine.history.undo.len() == groups_before + 1 {
        // One part put back what it replaced and left no undo step.
        model.undo.push((before, state(engine)));
        model.redo.clear();
        return format!("compose then type at {selection:?}, one step");
    }
    assert_eq!(engine.history.undo.len(), groups_before + 2);
    let group = &engine.history.undo[groups_before];
    let middle = State {
        source: {
            // The text after the commit alone: undo the input's records.
            let mut text = engine.source_text();
            for record in engine.history.undo[groups_before + 1].records.iter().rev() {
                text.replace_range(
                    record.start..record.start + record.inserted.len(),
                    &record.removed,
                );
            }
            text
        },
        selection: group.after.selection,
        affinity: group.after.affinity,
        selected_block: group.after.block_selected.then_some(group.after.selection),
    };
    model.edited_twice(engine, before, middle);
    format!("compose then type at {selection:?}")
}

/// An exact source record.
pub(super) fn source_step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    let revision = engine.revision();
    let before = state(engine);
    let groups = engine.history.undo.len();
    let source = engine.source_text();
    let mut a = random.below(source.len() + 1);
    while !source.is_char_boundary(a) {
        a -= 1;
    }
    let mut b = (a + random.below(4)).min(source.len());
    while !source.is_char_boundary(b) {
        b -= 1;
    }
    let text = random.pick(TYPED);
    let range = SourceRange {
        start: SourceOffset(a),
        end: SourceOffset(b),
    };
    if let Some(change) = engine.edit_source(revision, range, text, &mut ok).unwrap() {
        apply_view(view, &change);
        let mut want = source.clone();
        want.replace_range(a..b, text);
        assert_eq!(engine.source_text(), want);
        model.edited(engine, before, groups);
    }
    format!("edit source {a}..{b} to {text:?}")
}

/// `spanned` widened over a code block it reaches into or out of, which
/// goes whole, from its opening line through its closing line.
fn whole_blocks(engine: &Engine, spanned: &std::ops::Range<usize>) -> std::ops::Range<usize> {
    let first = engine.line_of(spanned.start);
    let last = engine.line_of(spanned.end);
    let start = fence_lines(engine, first).map_or(spanned.start, |(open, _)| {
        engine.line_start(open).min(spanned.start)
    });
    let end = fence_lines(engine, last).map_or(spanned.end, |(_, close)| {
        (engine.line_start(close) + engine.line(close).text.len()).max(spanned.end)
    });
    start..end
}

/// Typing over a block selected as one object replaces it, fences and all.
fn typed_over_selected_block(edit: &SourceEdit, text: &str) {
    let removed = edit.removed.trim_start_matches([' ', '\t']);
    assert!(
        edit.inserted == text && (removed.starts_with("```") || removed.starts_with("~~~")),
        "typing {text:?} over a selected block wrote {:?} over {:?}",
        edit.inserted,
        edit.removed
    );
}

/// The opening and closing (or last) line of the fence holding line `index`,
/// found by walking: an oracle independent of `CodeBlock`.
fn fence_lines(engine: &Engine, index: usize) -> Option<(usize, usize)> {
    let role = |index: usize| match engine.line(index).line.kind {
        Kind::Fence { role, .. } => Some(role),
        _ => None,
    };
    role(index)?;
    let mut open = index;
    while role(open) != Some(FenceRole::Open) {
        open -= 1;
    }
    let mut close = open + 1;
    while close < engine.line_count() && role(close) == Some(FenceRole::Code) {
        close += 1;
    }
    Some((open, close.min(engine.line_count() - 1)))
}

/// What typing on an empty line at line `index` of `source` writes before
/// the text: its line ending, and an empty code block's fence indent.
pub(super) fn empty_line_start(source: &str, index: usize) -> String {
    let engine = Engine::open(source);
    engine.empty_line_start(index)
}
