//! `[[` completion: the open run, its candidates and accepting one.
use super::*;

fn completing(source: &str, caret: usize) -> Engine {
    let mut engine = with_ids(source, VAULT);
    engine
        .select_with_affinity(Revision(0), range(caret, caret), Affinity::Backward)
        .unwrap();
    engine
}

fn offered(engine: &Engine) -> Option<(DisplayRange, String, Vec<String>)> {
    engine
        .wikilink_completion(engine.revision())
        .unwrap()
        .map(|c| {
            (
                c.range,
                c.query,
                c.candidates.into_iter().map(|n| n.note_id).collect(),
            )
        })
}

#[test]
fn the_open_run_and_its_candidates() {
    let all = ids(VAULT);
    let roadmap = || vec!["Projects/Roadmap"];
    for (source, caret, expected) in [
        ("a [[Ro", 6, Some((2, 6, "Ro", roadmap()))),
        // Empty and padded queries; folded, case-insensitive substring.
        (
            "[[",
            2,
            Some((0, 2, "", all.iter().map(String::as_str).collect())),
        ),
        (
            "[[ NOTES ",
            9,
            Some((0, 9, " NOTES ", vec!["Other/Notes", "Work/Notes"])),
        ),
        ("[[i", 3, Some((0, 3, "i", vec!["Ünï/İstanbul"]))),
        // No match still reports the run.
        ("[[zzz", 5, Some((0, 5, "zzz", vec![]))),
        (
            "[[a]] and [[Wo",
            14,
            Some((10, 14, "Wo", vec!["Work/Notes"])),
        ),
        ("x [[Ro]] y", 6, Some((2, 8, "Ro", roadmap()))),
        // The query is the source after `[[`; a wikilink's text is not Markdown.
        ("[[*zz", 5, Some((0, 5, "*zz", vec![]))),
        ("[[Roé", 4, Some((0, 4, "Ro", roadmap()))),
        // Display offsets: the list marker and indent are hidden.
        ("- [[Ro", 4, Some((0, 4, "Ro", roadmap()))),
        ("    [[Ro", 4, Some((0, 4, "Ro", roadmap()))),
        ("<div>\n[[Ro", 10, Some((6, 10, "Ro", roadmap()))),
        ("`[[Ro", 5, Some((1, 5, "Ro", roadmap()))),
        ("[[a\n[[Ro", 8, Some((4, 8, "Ro", roadmap()))),
        ("[[a]]", 5, None),
        ("[[a]] b", 7, None),
        ("no brackets", 4, None),
        ("[Ro", 3, None),
        // Code, an escaped bracket, a link's hidden bracket, front matter.
        ("`[[Ro` x", 4, None),
        ("```\n[[Ro", 4, None),
        ("\\[[Ro", 4, None),
        ("[[Ro](u)", 2, None),
        ("[[Ro\nnext", 9, None),
    ] {
        let engine = completing(source, caret);
        let expected = expected.map(|(from, to, query, notes)| {
            (
                range(from, to),
                query.to_owned(),
                notes.into_iter().map(str::to_owned).collect::<Vec<_>>(),
            )
        });
        assert_eq!(offered(&engine), expected, "{source:?} @{caret}");
    }
    // Front matter: the caret never rests there, so no run is open in it.
    let engine = completing("---\n[[Ro\n---\nbody", 0);
    assert_eq!(offered(&engine), None);

    // A run longer than 512 source bytes is not offered; bytes, not chars.
    for unit in ["x", "é"] {
        let source = format!("[[{}", unit.repeat(300));
        let caret = source.len();
        assert_eq!(
            offered(&completing(&source, caret)).is_some(),
            unit == "x",
            "{unit}"
        );
    }

    // Labels are the shortest unique suffix; the id is detail when it differs.
    let found = completing("[[o", 3)
        .wikilink_completion(Revision(0))
        .unwrap()
        .unwrap();
    let rows: Vec<_> = found
        .candidates
        .iter()
        .map(|c| (c.label.as_str(), c.detail.as_deref()))
        .collect();
    assert_eq!(
        rows,
        vec![
            ("Roadmap", Some("Projects/Roadmap")),
            ("Other/Notes", None),
            ("Work/Notes", None)
        ]
    );

    // A range selection or an open composition offers nothing.
    let mut engine = with_ids("[[Ro", VAULT);
    engine.select(Revision(0), range(0, 4)).unwrap();
    assert_eq!(offered(&engine), None);
    engine.select(Revision(0), range(4, 4)).unwrap();
    engine.compose(Revision(0), range(4, 4), "か").unwrap();
    assert_eq!(offered(&engine), None);

    // At most 20, in delivered order; unwritable ids are never offered.
    let mut many: Vec<String> = (0..50).map(|n| format!("Dir/note{n}")).collect();
    many.insert(0, "Dir/note]]x".to_owned());
    let mut engine = Engine::open("[[note");
    engine.update_note_ids(&many);
    engine.select(Revision(0), range(6, 6)).unwrap();
    let found = engine.wikilink_completion(Revision(0)).unwrap().unwrap();
    assert_eq!(found.candidates.len(), 20);
    assert_eq!(found.candidates[0].note_id, "Dir/note0");
}

#[test]
fn an_accepted_candidate_writes_only_the_changed_bytes() {
    let mut engine = completing("see [[Ro", 8);
    let found = engine.wikilink_completion(Revision(0)).unwrap().unwrap();
    let mut records: Vec<SourceEdit> = Vec::new();
    engine
        .accept_wikilink_completion(
            Revision(0),
            found.range,
            &found.query,
            "Projects/Roadmap",
            &mut |edit| {
                records.push(edit.clone());
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].removed, "Ro");
    assert_eq!(records[0].inserted, "Projects/Roadmap]]");
    assert_eq!(engine.wikilink_completion(Revision(1)).unwrap(), None);
    assert_eq!(roles(&engine)[0].3.as_deref(), Some("Projects/Roadmap"));
}

#[test]
fn stale_or_unacceptable_claims_change_nothing() {
    let id = "Projects/Roadmap";
    let claim = |source: &str, caret| {
        let engine = completing(source, caret);
        let found = engine.wikilink_completion(Revision(0)).unwrap().unwrap();
        (engine, found)
    };
    let accept = |engine: &mut Engine, revision, found: &WikilinkCompletion, id: &str| {
        let mut recorded = 0;
        let result = engine.accept_wikilink_completion(
            Revision(revision),
            found.range,
            &found.query,
            id,
            &mut |_| {
                recorded += 1;
                Ok(())
            },
        );
        assert_eq!(recorded, usize::from(result.is_ok()));
        result.map(|_| ())
    };

    let (mut e, found) = claim("[[Ro", 4);
    e.replace(Revision(0), range(4, 4), "a", InputAction::Typing, &mut ok)
        .unwrap();
    assert!(matches!(
        accept(&mut e, 0, &found, id),
        Err(EditorError::StaleRevision { .. })
    ));
    let (mut e, found) = claim("[[Ro", 4);
    e.select(Revision(0), range(1, 1)).unwrap();
    assert_eq!(accept(&mut e, 0, &found, id), Err(EditorError::StaleClaim));
    let (mut e, found) = claim("[[Ro", 4);
    let wrong = WikilinkCompletion {
        query: "R".into(),
        ..found.clone()
    };
    assert_eq!(accept(&mut e, 0, &wrong, id), Err(EditorError::StaleClaim));
    let (mut e, found) = claim("[[Ro", 4);
    e.update_note_ids(&ids(&["Other/Notes"]));
    assert_eq!(accept(&mut e, 0, &found, id), Err(EditorError::StaleClaim));
    let (mut e, found) = claim("[[Ro", 4);
    e.update_note_ids(&ids(&["a]]b", id]));
    assert_eq!(
        accept(&mut e, 0, &found, "a]]b"),
        Err(EditorError::InvalidText)
    );
    let (mut e, found) = claim("[[Ro", 4);
    e.compose(Revision(0), range(4, 4), "か").unwrap();
    assert_eq!(
        accept(&mut e, 0, &found, id),
        Err(EditorError::CompositionActive)
    );
    assert_eq!(e.source_text(), "[[Ro");
    // A refused acceptance puts the text back.
    let (mut e, found) = claim("[[Ro", 4);
    assert!(e
        .accept_wikilink_completion(Revision(0), found.range, &found.query, id, &mut |_| {
            Err("disk full".into())
        })
        .is_err());
    assert_eq!(e.source_text(), "[[Ro");
    assert!(!e.can_undo());
    // Requests leave no state: an id delivered after the request is acceptable.
    let (mut e, found) = claim("[[Ro", 4);
    e.update_note_ids(&ids(&[id, "Late/Note"]));
    assert_eq!(accept(&mut e, 0, &found, "Late/Note"), Ok(()));
    assert_eq!(e.source_text(), "[[Late/Note]]");
}
