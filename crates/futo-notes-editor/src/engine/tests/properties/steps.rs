//! Random edit steps, with properties 2 and 3 checked as they run.
use super::*;

pub(super) fn ok(_: &SourceEdit) -> Result<(), String> {
    Ok(())
}

/// What the history should hold, kept beside the engine.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct State {
    source: String,
    selection: DisplayRange,
    affinity: Affinity,
}

pub(super) fn state(engine: &Engine) -> State {
    State {
        source: engine.source_text(),
        selection: engine.selection(),
        affinity: engine.affinity(),
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

/// A renderer's copy of the display, and the windows it restyled.
#[derive(Default)]
pub(in crate::engine::tests) struct View {
    pub text: String,
    /// The display range of each change's lines since the last check.
    pub restyled: Vec<std::ops::Range<usize>>,
}

impl View {
    pub fn new(text: String) -> Self {
        Self {
            text,
            restyled: Vec::new(),
        }
    }
}

/// Apply a view change to a copy of the display, as a renderer would.
pub(in crate::engine::tests) fn apply_view(view: &mut View, change: &crate::engine::edit::Change) {
    view.text
        .replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    view.restyled.push(change.lines.clone());
}

/// One random step. Returns a description for failure messages.
pub(in crate::engine::tests) fn step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    match random.below(13) {
        10 | 11 => command_step(engine, model, view, random),
        12 => inline_step(engine, model, view, random),
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
    let at = engine.caret_source();
    // Every source offset that shows at the caret's display point, and
    // what the caret carries and shows before typing.
    let bounds = engine.source_bounds(selection.start.0);
    let carried = engine.formats.clone();
    let shown = engine.display_text();
    let empty_line = engine.empty_line(selection.start.0);
    // A selection's edit stays inside the source it spans: from the hidden
    // pieces at its start to those at its end (from 0 over front matter).
    let spanned = {
        let start = if engine.metadata_end().is_some() && selection.start.0 == 0 {
            0
        } else {
            engine.source_span(selection.start.0).0
        };
        start..engine.source_span(selection.end.0).1
    };
    // ... except that a fence frame line it cuts goes after the line the
    // text joins (`kept_frame`), at most through the line after that one.
    let reach = {
        let lines = engine.line_of(spanned.start)..engine.line_of(spanned.end) + 1;
        let cuts_frame = lines.into_iter().any(|index| {
            matches!(
                engine.line(index).line.kind,
                Kind::Fence {
                    role: FenceRole::Open | FenceRole::Close,
                    ..
                }
            )
        });
        let next = (engine.line_of(spanned.end) + 1).min(engine.line_count() - 1);
        if cuts_frame {
            engine.line_start(next) + engine.line(next).text.len()
        } else {
            spanned.end
        }
    };
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
        assert!(!collapsed, "typing {text:?} at a caret changed nothing");
        return format!("type {text:?} over {selection:?}, no change");
    };
    apply_view(view, &change);
    if !collapsed {
        let edited = change.edit.range.start.0..change.edit.range.end.0;
        assert!(
            spanned.start <= edited.start && edited.end <= reach,
            "replacing {selection:?} edited {edited:?}, outside {spanned:?} (reach {reach})"
        );
    }
    if collapsed {
        let written = match empty_line {
            Some(index) => format!("{}{text}", engine_ending(&before.source, index)),
            None => text.to_owned(),
        };
        let now = engine.source_text();
        let typed_at = |place: usize| {
            let mut want = before.source.clone();
            want.insert_str(place, &written);
            want
        };
        let lands = |place: usize| before.source.is_char_boundary(place) && typed_at(place) == now;
        let plain = lands(at) || (bounds.0..=bounds.1).any(lands);
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
                want.insert_str(selection.start.0, text);
                let context = format!("typing {text:?} under {formats:?} at {at}");
                assert_eq!(engine.display_text(), want, "{context}");
                let unmarked = |text: &str| text.replace(['*', '_', '~', '`'], "");
                assert_eq!(unmarked(&now), unmarked(&typed_at(at)), "{context}");
                super::inline::typed_formats(
                    engine,
                    selection.start.0,
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

/// The ending typing on an empty line at line `index` of `source` writes.
pub(super) fn engine_ending(source: &str, index: usize) -> String {
    let engine = Engine::open(source);
    engine.empty_line_ending(index)
}

/// A paragraph key or toolbar block command at the selection, through the
/// command families and the guard. Properties 3 and 4 hold for commands as
/// for typing; a cancelled command changes nothing.
pub(super) fn command_step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    use crate::{BlockCommand, ParagraphKey};
    let revision = engine.revision();
    let before = state(engine);
    let groups = engine.history.undo.len();
    let range = engine.selection();
    let (change, name) = if random.below(2) == 0 {
        let key = [
            ParagraphKey::Enter,
            ParagraphKey::ShiftEnter,
            ParagraphKey::Backspace,
            ParagraphKey::BackspaceJoiningHeading,
            ParagraphKey::Delete,
            ParagraphKey::Tab,
            ParagraphKey::ShiftTab,
        ][random.below(7)];
        (
            engine.key(revision, range, key, &mut ok).unwrap(),
            format!("key {key:?} at {range:?}"),
        )
    } else {
        let level = random.below(7) as u8;
        let command = [
            BlockCommand::Heading(level),
            BlockCommand::ToggleHeading(level.max(1)),
            BlockCommand::Quote,
            BlockCommand::Indent,
            BlockCommand::Outdent,
            BlockCommand::Divider,
            BlockCommand::ToggleTask,
            BlockCommand::BulletList,
            BlockCommand::OrderedList,
            BlockCommand::TaskList,
            BlockCommand::CodeBlock,
            BlockCommand::WrapCodeBlock,
        ][random.below(12)];
        (
            engine.block(revision, range, command, &mut ok).unwrap(),
            format!("command {command:?} at {range:?}"),
        )
    };
    match change {
        // A table key that only moves the selection.
        Some(change) if change.revision == revision => {
            assert!(change.inserted.is_empty(), "{name} moved only");
            assert_eq!(engine.source_text(), before.source, "{name} moved only");
            assert_eq!(engine.history.undo.len(), groups, "{name} moved only");
        }
        Some(change) => {
            view.text
                .replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            view.restyled
                .push(change.projection.range.start.0..change.projection.range.end.0);
            assert_eq!(change.revision, engine.revision(), "{name}");
            model.edited(engine, before, groups);
        }
        None => {
            assert_eq!(engine.revision(), revision, "{name} changed nothing");
            assert_eq!(
                engine.source_text(),
                before.source,
                "{name} changed nothing"
            );
        }
    }
    name
}
