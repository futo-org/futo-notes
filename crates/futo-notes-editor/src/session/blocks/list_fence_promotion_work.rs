use crate::*;

#[test]
fn promoted_fence_work_tracks_actual_code_and_foreign_forest_bytes() {
    for grow_code in [false, true] {
        let mut measured = Vec::new();
        for count in [64, 512] {
            let rows = if grow_code { count } else { 1 };
            let forest = if grow_code { 1 } else { count };
            let code = (0..rows)
                .map(|i| format!("  body{i}\n"))
                .collect::<String>();
            let expected_code = (0..rows).map(|i| format!("body{i}\n")).collect::<String>();
            let tail = (0..forest)
                .map(|i| format!("- outside{i}\n"))
                .collect::<String>();
            let raw = format!("- parent\n  ```Rust\n{code}{tail}");
            let expected = format!("parent\n```Rust\n{expected_code}```\n{tail}");
            let before = format!("parent\n{expected_code}{}", tail.replace("- ", ""));
            let candidate = EditorSession::open(&expected);
            assert_eq!(candidate.display_text(), before);
            let mut s = EditorSession::open(&raw);
            assert_eq!(s.display_text(), before);
            let selected = DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(0),
            };
            s.select_with_affinity(s.revision(), selected, Affinity::Backward)
                .unwrap();
            crate::inline::CONTAINER_METADATA_VISITS.with(|v| v.set(0));
            let mut accepted = 0;
            let change = s
                .block_command(
                    s.revision(),
                    selected,
                    BlockCommand::Heading(0),
                    &mut |_| {
                        accepted += 1;
                        Ok(())
                    },
                )
                .unwrap()
                .unwrap();
            let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|v| v.get());
            assert_eq!(accepted, 1);
            assert_eq!(s.source_text(), expected);
            let mut shown = before.clone();
            shown.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(shown, before);
            assert_eq!(s.selection(), selected);
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.selection(), selected);
            assert_eq!(s.affinity(), Affinity::Backward);
            s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), expected);
            measured.push((
                raw.len(),
                visits,
                change.work.parsed_source_bytes,
                change.work.materialized_source_bytes,
            ));
        }
        let (a, va, pa, ca) = measured[0];
        let (b, vb, pb, cb) = measured[1];
        assert!(
            vb * a < 2 * va * b,
            "fence metadata {va}->{vb} input{a}->{b} growCode{grow_code}"
        );
        assert!(
            pb * a < 2 * pa * b,
            "fence parser {pa}->{pb} input{a}->{b} growCode{grow_code}"
        );
        assert!(
            cb * a < 2 * ca * b,
            "fence copies {ca}->{cb} input{a}->{b} growCode{grow_code}"
        );
    }
}

#[test]
fn multiple_fence_planning_preview_and_commit_have_bounded_actual_work_growth() {
    let mut measured = Vec::new();
    for count in [64, 512] {
        let mut raw = "- parent\n\n  continuation\n\n".to_owned();
        let mut expected = "parent\n\ncontinuation\n\n".to_owned();
        let mut shown = "parent\n\ncontinuation\n\n".to_owned();
        for index in 0..count {
            raw.push_str(&format!("  ```lang{index}\n  opaque{index}\n"));
            expected.push_str(&format!("```lang{index}\nopaque{index}\n```\n"));
            shown.push_str(&format!("opaque{index}\n"));
            if index + 1 < count {
                raw.push_str("  ```\n\n");
                expected.push('\n');
                shown.push('\n');
            }
        }
        raw.push_str("- outside");
        expected.push_str("- outside");
        shown.push_str("outside");
        let target = EditorSession::open(&expected);
        assert_eq!(target.display_text(), shown);
        let mut session = EditorSession::open(&raw);
        assert_eq!(session.display_text(), shown);
        let selected = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(3),
        };
        session
            .select_with_affinity(Revision(0), selected, Affinity::Backward)
            .unwrap();
        crate::inline::CONTAINER_METADATA_VISITS.with(|v| v.set(0));
        let mut accepted = 0;
        let change = session
            .block_command(Revision(0), selected, BlockCommand::Heading(0), &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap();
        let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|v| v.get());
        assert_eq!(accepted, 1);
        assert_eq!(session.source_text(), expected);
        let mut view = shown.clone();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, shown);
        assert_eq!(session.display_text(), shown);
        assert_eq!(session.selection(), selected);
        let projection = session
            .project(
                session.revision(),
                DisplayRange {
                    start: DisplayOffset(0),
                    end: DisplayOffset(shown.len()),
                },
            )
            .unwrap();
        assert_eq!(projection.blocks.iter().filter(|b| b.code).count(), count);
        assert!(projection
            .blocks
            .iter()
            .filter(|b| b.code)
            .all(|b| b.list.is_none()
                && b.quote_depth == 0
                && b.language
                    .as_deref()
                    .is_some_and(|language| language.starts_with("lang"))));
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), raw);
        assert_eq!(session.selection(), selected);
        assert_eq!(session.affinity(), Affinity::Backward);
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), expected);
        assert!(
            visits > 0
                && change.work.parsed_source_bytes > 0
                && change.work.materialized_source_bytes > 0
        );
        measured.push((
            raw.len(),
            visits,
            change.work.parsed_source_bytes,
            change.work.materialized_source_bytes,
        ));
    }
    let (a, va, pa, ca) = measured[0];
    let (b, vb, pb, cb) = measured[1];
    assert!(
        vb * a < 2 * va * b,
        "multiple fence metadata{va}->{vb} input{a}->{b}"
    );
    assert!(
        pb * a < 2 * pa * b,
        "multiple fence parser{pa}->{pb} input{a}->{b}"
    );
    assert!(
        cb * a < 2 * ca * b,
        "multiple fence copies{ca}->{cb} input{a}->{b}"
    );
}
