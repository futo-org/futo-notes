use super::*;

#[test]
fn store_note_ids_reach_a_composing_session_and_recovery_keeps_exact_bytes() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("Projects", "Roadmap", "").unwrap();
    store.create("", "home", "[[Roadmap]] ab").unwrap();
    let mut session = store.open_editor("home").unwrap();
    let change = session.refresh_note_ids().unwrap();
    let link = &change.projections[0].wikilinks[0];
    assert_eq!(link.note_id.as_deref(), Some("Projects/Roadmap"));
    assert_eq!(link.label, "Roadmap");

    session.compose(Revision(0), range(14, 14), "か").unwrap();
    store.create("Archive", "Roadmap", "").unwrap();
    let change = session.refresh_note_ids().unwrap();
    assert_eq!(change.revision, Revision(0));
    assert_eq!(change.projections[0].wikilinks[0].note_id, None);
    assert_eq!(session.composition().unwrap().text, "か");
    session
        .commit_composition(Revision(0), None)
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), "[[Roadmap]] abか");
    session.flush_recovery().unwrap();
    drop(session);

    let mut recovered = store.open_editor("home").unwrap();
    assert_eq!(recovered.source_text(), "[[Roadmap]] abか");
    recovered.refresh_note_ids().unwrap();
    let roles = recovered
        .project(Revision(1), range(0, 17))
        .unwrap()
        .wikilinks;
    assert_eq!(roles[0].note_id, None);
    recovered.checkpoint().unwrap();
    assert_eq!(store.read("home").unwrap(), "[[Roadmap]] abか");
    assert_eq!(store.read("Projects/Roadmap").unwrap(), "");
}
