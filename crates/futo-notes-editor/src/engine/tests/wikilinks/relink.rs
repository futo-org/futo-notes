//! Own-action relinks and history.
use super::*;

#[test]
fn a_relink_is_one_undo_step_above_untouched_history() {
    let mut engine = Engine::open("see [[Old]]");
    engine.select(Revision(0), range(11, 11)).unwrap();
    engine
        .replace(
            Revision(0),
            range(11, 11),
            "!",
            InputAction::Typing,
            &mut ok,
        )
        .unwrap();
    engine.undo(Revision(1), &mut ok).unwrap().unwrap();
    engine.redo(Revision(2), &mut ok).unwrap().unwrap();
    engine
        .replace(
            Revision(3),
            range(12, 12),
            "?",
            InputAction::Isolated,
            &mut ok,
        )
        .unwrap();
    engine.undo(Revision(4), &mut ok).unwrap().unwrap();
    assert!(engine.can_redo());
    let mut records = 0;
    engine
        .apply_own_relink(Revision(5), "see [[New]]!", &mut |_| {
            records += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(records, 1);
    assert!(!engine.can_redo(), "a relink clears Redo like any edit");
    engine.undo(Revision(6), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "see [[Old]]!");
    // The older entry applies to the exact source it was recorded against.
    engine.undo(Revision(7), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "see [[Old]]");

    // A composition, a stale revision and a refused acceptance change nothing.
    let mut engine = Engine::open("[[Old]] x");
    engine.select(Revision(0), range(9, 9)).unwrap();
    engine.compose(Revision(0), range(9, 9), "か").unwrap();
    assert_eq!(
        engine.apply_own_relink(Revision(0), "[[New]] x", &mut ok),
        Err(EditorError::CompositionActive)
    );
    let mut engine = Engine::open("[[Old]] x");
    assert!(matches!(
        engine.apply_own_relink(Revision(3), "[[New]] x", &mut ok),
        Err(EditorError::StaleRevision { .. })
    ));
    assert!(engine
        .apply_own_relink(Revision(0), "[[New]] x", &mut |_| Err("no".into()))
        .is_err());
    assert_eq!(engine.source_text(), "[[Old]] x");
    assert!(!engine.can_undo());
}
