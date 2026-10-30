use super::*;

fn ordinals(session: &EditorSession) -> Vec<u64> {
    let end = session.display_text().len();
    let mut blocks = session
        .project(session.revision(), range(0, end))
        .unwrap()
        .blocks;
    for block in session
        .project(session.revision(), range(end, end))
        .unwrap()
        .blocks
    {
        if !blocks.contains(&block) {
            blocks.push(block);
        }
    }
    blocks
        .into_iter()
        .filter_map(|block| {
            block
                .list
                .filter(|list| list.first)
                .and_then(|list| list.number)
        })
        .collect()
}

#[test]
fn shortcuts_retain_foreign_bytes_and_interpreted_ordinals_across_transparent_gaps() {
    for blanks in [1, 2, 3, 9] {
        for quote in ["", "> ", "> > "] {
            for eol in ["\n", "\r\n"] {
                for before in ['.', ')'] {
                    for after in ['.', ')'] {
                        for number in [2, 1000] {
                            for body in ["", "**🦊é**"] {
                                let gap = format!("{}{eol}", quote.trim_end()).repeat(blanks);
                                let prefix = format!("{quote}999{before} __before__{eol}{gap}");
                                let suffix = format!(
                                    "{gap}{quote}7{after} **after**{eol}{quote}1{after} tail"
                                );
                                let dot = if body.is_empty() { "\\." } else { "." };
                                let raw =
                                    format!("{prefix}{quote}{number}{dot}{body}{eol}{suffix}");
                                let shown = format!(
                                    "before{}{number}.{}{}after{eol}tail",
                                    eol.repeat(blanks + 1),
                                    if body.is_empty() { "" } else { "🦊é" },
                                    eol.repeat(blanks + 1)
                                );
                                let mut session = EditorSession::open(&raw);
                                assert_eq!(session.display_text(), shown, "{raw:?}");
                                let mut view = ReferenceView::new(&shown);
                                let at = shown.find(&format!("{number}.")).unwrap()
                                    + number.to_string().len()
                                    + 1;
                                session
                                    .select_with_affinity(
                                        session.revision(),
                                        range(at, at),
                                        Affinity::Backward,
                                    )
                                    .unwrap();
                                let mut accepts = 0;
                                view.apply(
                                    session
                                        .replace(
                                            session.revision(),
                                            range(at, at),
                                            " ",
                                            &mut |_| {
                                                accepts += 1;
                                                Ok(())
                                            },
                                        )
                                        .unwrap(),
                                );
                                assert_eq!(accepts, 1);
                                let source = session.source_text();
                                assert!(source.starts_with(&prefix), "{source:?}");
                                assert!(source.ends_with(&suffix), "{source:?}");
                                assert_eq!(ordinals(&session), [999, number, 7, 8], "{raw:?}");
                                let fresh = EditorSession::open(&source);
                                assert_eq!(ordinals(&fresh), [999, number, 7, 8], "{source:?}");
                                assert_eq!(view.text, fresh.display_text());
                                assert_eq!(session.affinity(), Affinity::Backward);
                                view.apply(
                                    session
                                        .undo(session.revision(), &mut |_| Ok(()))
                                        .unwrap()
                                        .unwrap(),
                                );
                                assert_eq!(session.source_text(), raw);
                                assert_eq!(view.text, shown);
                                assert_eq!(session.selection(), range(at, at));
                                view.apply(
                                    session
                                        .redo(session.revision(), &mut |_| Ok(()))
                                        .unwrap()
                                        .unwrap(),
                                );
                                assert_eq!(session.source_text(), source);
                                assert_eq!(ordinals(&session), [999, number, 7, 8]);
                            }
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn semantic_context_stops_at_substantive_barriers_and_keeps_protected_triggers_literal() {
    for gap in ["\n\n", "\n\n\n", "\n\n\n\n\n\n\n\n\n\n"] {
        for boundary in [
            "boundary\n\n",
            "# boundary\n\n",
            "<!-- -->\n",
            "---\n\n",
            "```\nopaque\n```\n\n",
            "> boundary\n\n",
        ] {
            let raw = format!("2.body{gap}{boundary}7. after");
            let mut session = EditorSession::open(&raw);
            let mut view = ReferenceView::new(&session.display_text());
            view.apply(
                session
                    .replace(session.revision(), range(2, 2), " ", &mut |_| Ok(()))
                    .unwrap(),
            );
            assert_eq!(
                session.source_text(),
                format!("2. body{gap}{boundary}7. after")
            );
            assert_eq!(ordinals(&session), [2, 7]);
            let fresh = EditorSession::open(&session.source_text());
            assert_eq!(ordinals(&fresh), [2, 7]);
            assert_eq!(view.text, fresh.display_text());
        }
    }
    for (raw, at, expected, numbers) in [
        (
            "```\n2.body\n```\n\n\n7. after",
            6,
            "```\n2. body\n```\n\n\n7. after",
            vec![7],
        ),
        (
            "    2.body\n\n\n7. after",
            6,
            "    2. body\n\n\n7. after",
            vec![7],
        ),
        (
            "`2.body`\n\n\n7. after",
            2,
            "`2. body`\n\n\n7. after",
            vec![7],
        ),
        (
            "```\n2.body\n\n\n7. after",
            6,
            "```\n2. body\n\n\n7. after",
            vec![],
        ),
        (
            "1234567890.body\n\n\n7. after",
            11,
            "1234567890. body\n\n\n7. after",
            vec![7],
        ),
        (
            "0000000002.body\n\n\n7. after",
            11,
            "0000000002. body\n\n\n7. after",
            vec![7],
        ),
    ] {
        let mut session = EditorSession::open(raw);
        let mut view = ReferenceView::new(&session.display_text());
        view.apply(
            session
                .replace(session.revision(), range(at, at), " ", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected);
        assert_eq!(ordinals(&EditorSession::open(expected)), numbers);
        assert_eq!(view.text, session.display_text());
    }
}
