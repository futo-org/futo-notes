//! A random step under `InputAction::PairedTyping`, so every property runs
//! over its pairs, steps and code blocks.
use super::*;

/// A backtick (sometimes other text) typed under paired typing. A step
/// that changes nothing leaves the source and revision as they were.
pub(super) fn paired_step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    let revision = engine.revision();
    let before = state(engine);
    let source = engine.source_text();
    let groups = engine.history.undo.len();
    let selection = engine.selection();
    let text = if random.below(4) == 0 {
        random.pick(TYPED)
    } else {
        "`"
    };
    let change = engine
        .paired_input(revision, selection, text, &mut ok)
        .unwrap_or_else(|error| panic!("paired typing {text:?} refused: {error:?} in {before:?}"));
    let Some(change) = change else {
        assert_eq!(engine.source_text(), source, "paired {text:?}");
        assert_eq!(engine.revision(), revision, "paired {text:?}");
        return format!(
            "paired {text:?} at {selection:?}, moved to {:?}",
            engine.selection()
        );
    };
    apply_view(view, &change);
    model.edited(engine, before, groups);
    format!("paired {text:?} at {selection:?}")
}
