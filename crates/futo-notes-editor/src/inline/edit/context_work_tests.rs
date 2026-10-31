use crate::*;

#[test]
fn first_plain_list_input_planning_avoids_quadratic_container_visits() {
    let mut counts = Vec::new();
    for items in [200, 400] {
        let raw = "- item\n".repeat(items);
        let shown = "item\n".repeat(items);
        let mut session = EditorSession::open(&raw);
        assert_eq!(session.display_text(), shown);
        crate::inline::CONTAINER_METADATA_VISITS.with(|visits| visits.set(0));
        let mut acceptances = 0;
        let result = session.replace_action(
            Revision(0),
            DisplayRange::default(),
            "x",
            InputAction::Typing,
            &mut |edit| {
                acceptances += 1;
                assert_eq!(edit.range.start, SourceOffset(2));
                assert_eq!(edit.range.end, SourceOffset(2));
                assert_eq!(edit.inserted, "x");
                assert_eq!(edit.removed, "");
                // Stop at the first host acceptance: no Store append, apply,
                // or returned full projection contributes to this ledger.
                Err("reject planning probe".into())
            },
        );
        assert!(
            matches!(result, Err(EditorError::Persistence(message)) if message == "reject planning probe")
        );
        assert_eq!(acceptances, 1);
        let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|visits| visits.get());
        eprintln!("plain list items={items} pre-accept container visits={visits}");
        assert!(visits > 0);
        counts.push(visits);
        assert_eq!(session.revision(), Revision(0));
        assert_eq!(session.source_text(), raw);
        assert_eq!(session.display_text(), shown);
        assert_eq!(session.selection(), DisplayRange::default());
        assert!(session
            .undo(Revision(0), &mut |_| panic!(
                "rejected input has no undo edit"
            ))
            .unwrap()
            .is_none());
    }
    // Doubling this retained list may grow with the region (and its lookup
    // depth), but must not repeat all physical blocks for every hidden prefix.
    assert!(counts[1] < 3 * counts[0], "pre-accept visits={counts:?}");
}
