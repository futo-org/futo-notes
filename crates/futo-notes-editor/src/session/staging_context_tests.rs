use super::*;

#[test]
fn capturing_nested_origins_skips_foreign_bodies_and_blank_subtrees() {
    for blanks in [9, 1000, 20_000] {
        for body_bytes in [8, 100_000] {
            let gap = "\n".repeat(blanks + 1);
            let raw = format!(
                "999. {}\n1. lazy{gap}body\n{gap}7) {}",
                "x".repeat(body_bytes),
                "y".repeat(body_bytes)
            );
            let session = EditorSession::open(&raw);
            let at = raw.find("body").unwrap();
            crate::inline::CONTEXT_VISITS.with(|visits| visits.set(0));
            let staged = session.stage_source("body\n", at..at + 5);
            let nested = staged.stage_source("body\n", 0..5);
            let before = nested.semantic_neighbor(0, false, 0).unwrap();
            let after = nested.semantic_neighbor(5, true, 0).unwrap();
            assert_eq!(before.witness.list.unwrap().ordinal, Some(1000));
            assert_eq!(after.witness.list.unwrap().ordinal, Some(7));
            let visits = crate::inline::CONTEXT_VISITS.with(|visits| visits.get());
            assert!(
                visits > 0 && visits < 640,
                "blanks={blanks}, body={body_bytes}, visits={visits}"
            );
            assert_eq!(nested.source.len_bytes(), 5);
        }
    }
}

fn meaning(
    neighbor: Option<Neighbor>,
) -> Option<(
    usize,
    bool,
    bool,
    Option<usize>,
    Option<u8>,
    Option<u64>,
    Option<usize>,
)> {
    neighbor.map(|n| {
        (
            n.witness.quote_depth,
            n.witness.code,
            n.witness.empty_comment,
            n.witness.transparent_quote,
            n.marker,
            n.witness.list.as_ref().and_then(|l| l.ordinal),
            n.witness.list.as_ref().map(|l| l.depth),
        )
    })
}

#[test]
fn boundary_carriers_equal_canonical_queries_at_every_source_cut_and_quote_depth() {
    for eol in ["\n", "\r\n"] {
        for middle in [
            "",
            "\n\n",
            ">\n>\n",
            "> >\n> >\n",
            ">\n\n> >\n",
            "<!-- -->\n",
            "```\ncode\n```\n",
            "**a\nb**\n",
            "`a\nb`\n",
            "# heading\n",
        ] {
            let raw = format!("999. before\n1. lazy\n\n{middle}\n7) after\n").replace('\n', eol);
            let session = EditorSession::open(&raw);
            for at in raw
                .char_indices()
                .filter_map(|(at, ch)| (ch == '\n').then_some(at + 1))
                .chain([0, raw.len()])
            {
                let staged = session.stage_source("", at..at);
                let nested = staged.stage_source("", 0..0);
                for quote in [0, 1, 2, 3, 19, usize::MAX] {
                    for forward in [false, true] {
                        let expected = meaning(session.semantic_neighbor(at, forward, quote));
                        assert_eq!(
                            meaning(staged.semantic_neighbor(0, forward, quote)),
                            expected,
                            "{raw:?} at={at} quote={quote} forward={forward}"
                        );
                        assert_eq!(
                            meaning(nested.semantic_neighbor(0, forward, quote)),
                            expected
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn local_edits_override_external_witnesses_without_reusing_foreign_coordinates() {
    let session = EditorSession::open("999. before\n1. lazy\n\nbody\n\n\n7) after");
    let at = session.source_text().find("body").unwrap();
    for replacement in [
        "",
        "\n\n",
        ">\n",
        "> >\n",
        "<!-- -->\n",
        "plain\n",
        "3. body\n",
    ] {
        let mut staged = session.stage_source("body\n", at..at + 5);
        staged
            .replace_action(
                staged.revision(),
                DisplayRange {
                    start: DisplayOffset(0),
                    end: DisplayOffset(5),
                },
                replacement,
                crate::InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap();
        let local = EditorSession::open(&staged.source_text());
        for quote in [0, 1, 2, 3] {
            for forward in [false, true] {
                let point = if forward {
                    0
                } else {
                    staged.source.len_bytes()
                };
                let expected = local.semantic_neighbor(point, forward, quote);
                let actual = staged.semantic_neighbor(point, forward, quote);
                if expected.is_some() {
                    assert_eq!(
                        meaning(actual),
                        meaning(expected),
                        "{replacement:?}, quote={quote}"
                    );
                } else if let Some(neighbor) = actual {
                    assert!(!neighbor.local);
                    assert_eq!(
                        meaning(Some(neighbor)),
                        meaning(session.semantic_neighbor(
                            if forward { at + 5 } else { at },
                            forward,
                            quote
                        ))
                    );
                }
            }
        }
        let nested = staged.stage_source(&staged.source_text(), 0..staged.source.len_bytes());
        assert_eq!(
            meaning(nested.semantic_neighbor(0, false, 0)),
            meaning(staged.semantic_neighbor(0, false, 0))
        );
        assert_eq!(
            meaning(nested.semantic_neighbor(nested.source.len_bytes(), true, 0)),
            meaning(staged.semantic_neighbor(staged.source.len_bytes(), true, 0))
        );
    }
}
