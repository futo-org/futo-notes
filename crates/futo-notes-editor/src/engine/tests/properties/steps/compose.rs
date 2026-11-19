//! Steps that compose marked text.
use super::*;

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
