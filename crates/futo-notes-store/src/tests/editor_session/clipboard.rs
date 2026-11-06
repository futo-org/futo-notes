use super::*;

#[test]
fn paste_and_cut_survive_rejected_append_recovery_and_checkpoint() {
    let root = TestRoot::new();
    let store = store(&root);
    let original = "ab **cd**\r\nend\r\n";
    store.create("", "clip", original).unwrap();
    let mut session = store.open_editor("clip").unwrap();
    assert_eq!(session.source_text(), original);
    // A paused draft stays copyable.
    assert_eq!(
        session.copy_markdown(Revision(0), range(4, 5)).unwrap(),
        "**d**"
    );
    session
        .paste_markdown(Revision(0), range(1, 1), "x \t\n# T\ny")
        .unwrap()
        .unwrap();
    let pasted = "ax \t\r\n# T\r\nyb **cd**\r\nend\r\n";
    assert_eq!(session.source_text(), pasted);
    let (copied, _) = session.cut_markdown(Revision(1), range(12, 14)).unwrap();
    assert_eq!(copied, "**cd**");
    let cut = "ax \t\r\n# T\r\nyb \r\nend\r\n";
    assert_eq!(session.source_text(), cut);
    session.undo(Revision(2)).unwrap().unwrap();
    assert_eq!(session.source_text(), pasted);
    session.redo(Revision(3)).unwrap().unwrap();
    session.checkpoint().unwrap();
    drop(session);
    let mut recovered = store.open_editor("clip").unwrap();
    assert_eq!(recovered.source_text(), cut);
    recovered.checkpoint().unwrap();
    assert_eq!(store.read("clip").unwrap(), cut);
}
