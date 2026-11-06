use super::*;

#[test]
fn store_note_ids_reach_a_composing_session_and_save_keeps_exact_bytes() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("Projects", "Roadmap", "").unwrap();
    store.create("", "home", "[[Roadmap]] ab").unwrap();
    let mut session = store.open_editor("home").unwrap();
    // Open already delivered the ids; refreshing an unchanged vault changes nothing.
    let link = &session
        .project(Revision(0), range(0, 11))
        .unwrap()
        .wikilinks[0];
    assert_eq!(link.note_id.as_deref(), Some("Projects/Roadmap"));
    assert_eq!(link.label, "Roadmap");
    assert!(session.refresh_note_ids().unwrap().projections.is_empty());

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
    assert_eq!(session.source_text(), "[[Roadmap]] abか\n");
    session.checkpoint().unwrap();
    drop(session);

    let mut recovered = store.open_editor("home").unwrap();
    assert_eq!(recovered.source_text(), "[[Roadmap]] abか\n");
    recovered.refresh_note_ids().unwrap();
    let roles = recovered
        .project(recovered.revision(), range(0, 17))
        .unwrap()
        .wikilinks;
    assert_eq!(roles[0].note_id, None);
    recovered.checkpoint().unwrap();
    assert_eq!(store.read("home").unwrap(), "[[Roadmap]] abか\n");
    assert_eq!(store.read("Projects/Roadmap").unwrap(), "");
}

#[test]
fn note_ids_are_delivered_on_open_without_a_refresh() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("Projects", "Roadmap", "").unwrap();
    store
        .create("", "home", "```Rust\nab\n```\n\n[[Roadmap]]")
        .unwrap();
    let id_of = |session: &StoreEditorSession<'_>| {
        let end = session.display_text().len();
        session
            .project(Revision(0), range(0, end))
            .unwrap()
            .wikilinks[0]
            .note_id
            .clone()
    };
    let session = store.open_editor("home").unwrap();
    assert_eq!(id_of(&session).as_deref(), Some("Projects/Roadmap"));
}

#[test]
fn completion_accepts_one_recovered_edit_and_refused_acceptance_changes_nothing() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("Projects", "Roadmap", "").unwrap();
    store.create("", "home", "see [[Ro").unwrap();
    let mut session = store.open_editor("home").unwrap();
    session
        .select_with_affinity(
            Revision(0),
            range(8, 8),
            futo_notes_editor::Affinity::Forward,
        )
        .unwrap();
    let found = session.wikilink_completion(Revision(0)).unwrap().unwrap();
    assert_eq!(found.candidates[0].note_id, "Projects/Roadmap");

    assert_eq!(session.source_text(), "see [[Ro\n");
    session
        .accept_wikilink_completion(Revision(0), found.range, &found.query, "Projects/Roadmap")
        .unwrap();
    // Stale after the accepted edit: nothing more is appended.
    assert!(session
        .accept_wikilink_completion(Revision(0), found.range, &found.query, "Projects/Roadmap")
        .is_err());
    session.checkpoint().unwrap();
    drop(session);
    let recovered = store.open_editor("home").unwrap();
    assert_eq!(recovered.source_text(), "see [[Projects/Roadmap]]\n");
}
