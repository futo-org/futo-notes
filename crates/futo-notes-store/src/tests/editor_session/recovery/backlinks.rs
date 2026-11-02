use super::*;

#[test]
fn live_backlink_rewrite_restoring_old_checkpoint_keeps_its_own_baseline() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "Target", "target").unwrap();
    store.create("", "plain", "[[Target]]").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(10, 10), "!").unwrap();
    store.rename("Target", "Renamed").unwrap();
    assert_eq!(store.read("plain").unwrap(), "[[Renamed]]");
    assert_eq!(editor.source_text(), "[[Target]]!");
    store.rename("Renamed", "Target").unwrap();
    assert_eq!(editor.source_text(), "[[Target]]!");
    let saved = editor.checkpoint().unwrap();
    assert_eq!(saved.disposition, FlushDisposition::Wrote);
    assert_eq!(store.read("plain").unwrap(), "[[Target]]!");
    assert_eq!(store.snapshot().notes.len(), 2);
}
