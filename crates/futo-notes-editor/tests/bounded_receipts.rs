use futo_notes_editor::*;

#[test]
fn refused_entry_returns_its_retained_metadata_work_with_the_original_full_owner() {
    let full = EditorSession::open("plain\n");
    let failure = full
        .into_bounded(Revision(0), SessionToken(74), DisplayOffset(0))
        .err()
        .unwrap();
    assert_eq!(failure.error, BoundedError::Unsupported);
    assert!(
        failure.work.metadata_items > 0,
        "entry searched retained metadata before refusing"
    );
    assert_eq!(failure.session.last_bounded_operation_work(), failure.work);
    assert_eq!(failure.session.source_text(), "plain\n");
    assert_eq!(failure.session.display_text(), "plain\n");
    assert_eq!(failure.session.revision(), Revision(0));
}

#[test]
fn materialization_counts_each_source_pass_and_each_retained_redo_group_and_entry() {
    fn session() -> BoundedEditorSession {
        EditorSession::open("```\nab\n```\n")
            .into_bounded(Revision(0), SessionToken(75), DisplayOffset(0))
            .unwrap()
    }
    fn insert(session: &mut BoundedEditorSession, at: usize, text: &str) {
        session
            .insert_literal(session.cursor(), DisplayOffset(at), text, &mut |_| Ok(()))
            .unwrap();
    }
    fn undo(session: &mut BoundedEditorSession) {
        session
            .undo_bounded(session.cursor(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
    }
    let mut direct = session();
    insert(&mut direct, 0, "x");
    let (direct, direct_work) = direct.materialize();
    let mut roundtrip = session();
    insert(&mut roundtrip, 0, "x");
    undo(&mut roundtrip);
    roundtrip
        .redo_bounded(roundtrip.cursor(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    let (roundtrip, roundtrip_work) = roundtrip.materialize();
    assert_eq!(direct.source_text(), "```\nxab\n```\n");
    assert_eq!(roundtrip.source_text(), direct.source_text());
    // The canonical aggregate edit and deferred history are identical. Two
    // extra accepted records are each visited in both source replay passes.
    assert_eq!(
        roundtrip_work.metadata_items,
        direct_work.metadata_items + 4
    );

    let mut single = session();
    insert(&mut single, 0, "x");
    undo(&mut single);
    let (mut single, single_work) = single.materialize();
    let mut grouped = session();
    insert(&mut grouped, 0, "x");
    insert(&mut grouped, 1, "y");
    undo(&mut grouped);
    let (mut grouped, grouped_work) = grouped.materialize();
    // Same unchanged aggregate source, one more source record in both passes
    // and one more retained Redo entry in the same group.
    assert_eq!(grouped_work.metadata_items, single_work.metadata_items + 3);

    let mut split = session();
    insert(&mut split, 0, "x");
    split
        .select_bounded(split.cursor(), DisplayRange::default(), Affinity::Forward)
        .unwrap();
    let at = DisplayOffset(1);
    split
        .select_bounded(
            split.cursor(),
            DisplayRange { start: at, end: at },
            Affinity::Forward,
        )
        .unwrap();
    insert(&mut split, 1, "y");
    undo(&mut split);
    undo(&mut split);
    let (mut split, split_work) = split.materialize();
    // One more accepted record in both source passes and one extra Redo group;
    // both cases retain exactly the two x/y entries.
    assert_eq!(split_work.metadata_items, grouped_work.metadata_items + 3);
    for full in [&single, &grouped, &split] {
        assert_eq!(full.source_text(), "```\nab\n```\n");
        assert_eq!(full.selection(), DisplayRange::default());
    }
    single
        .redo(single.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    grouped
        .redo(grouped.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    split
        .redo(split.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(single.source_text(), "```\nxab\n```\n");
    assert_eq!(grouped.source_text(), "```\nxyab\n```\n");
    assert_eq!(split.source_text(), "```\nxab\n```\n");
}

#[test]
fn refused_grouped_undo_charges_every_inspected_entry_and_keeps_full_history() {
    struct Clock;
    impl HistoryClock for Clock {
        fn now(&self) -> std::time::Duration {
            std::time::Duration::ZERO
        }
    }
    let source = "```\nab\n```\n";
    let mut session = EditorSession::open_with_clock(source, std::sync::Arc::new(Clock))
        .into_bounded(Revision(0), SessionToken(76), DisplayOffset(0))
        .unwrap();
    for at in 0..33 {
        session
            .insert_literal(session.cursor(), DisplayOffset(at), "x", &mut |_| Ok(()))
            .unwrap();
    }
    let before = session.cursor();
    let display = session.display_text();
    let source_before = session.source_text();
    assert_eq!(
        session.undo_bounded(before, &mut |_| panic!("oversized Undo appended")),
        Err(BoundedError::Unsupported)
    );
    assert_eq!(
        session.last_operation_work(),
        BoundedWork {
            metadata_items: 33,
            ..Default::default()
        }
    );
    assert_eq!(session.cursor(), before);
    assert_eq!(session.display_text(), display);
    assert_eq!(session.source_text(), source_before);
    let (mut full, _) = session.materialize();
    full.undo(full.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(full.source_text(), source);
}
