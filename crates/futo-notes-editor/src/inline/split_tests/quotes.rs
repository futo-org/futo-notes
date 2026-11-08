use super::*;

fn quoted_lines(lines: usize, body: impl Fn(usize) -> String) -> String {
    (0..lines).map(|i| format!("> {}\n", body(i))).collect()
}

#[test]
fn explicit_quote_cuts_match_an_uncut_twin_through_source_and_structural_edits() {
    let source = quoted_lines(400, |i| format!("row {i} with **bold** and *italic*"));
    let mut cut = EditorSession::open(&source);
    assert!(
        cut.projection.rows.len() > 1,
        "quoted paragraph must have bounded rows"
    );
    let mut twin = uncut(|| EditorSession::open(&source));
    assert_eq!(whole(&cut), whole(&twin));
    for (inserted, key) in [
        ("x", None),
        ("", Some(ParagraphKey::Enter)),
        ("*", None),
        ("\n> ", None),
        ("", Some(ParagraphKey::Backspace)),
    ] {
        let text = cut.display_text();
        let at = text.len() / 2 + text[text.len() / 2..].find('\n').unwrap_or(0);
        let selected = range(at, at);
        cut.select(cut.revision(), selected).unwrap();
        twin.select(twin.revision(), selected).unwrap();
        let got = if let Some(key) = key {
            cut.paragraph_key(cut.revision(), selected, key, &mut |_| Ok(()))
                .map(|v| v.is_some())
        } else {
            cut.replace(cut.revision(), selected, inserted, &mut |_| Ok(()))
                .map(|_| true)
        };
        let want = uncut(|| {
            if let Some(key) = key {
                twin.paragraph_key(twin.revision(), selected, key, &mut |_| Ok(()))
                    .map(|v| v.is_some())
            } else {
                twin.replace(twin.revision(), selected, inserted, &mut |_| Ok(()))
                    .map(|_| true)
            }
        });
        assert_eq!(got, want);
        assert_eq!(whole(&cut), whole(&twin));
        assert_eq!(
            whole(&cut),
            uncut(|| whole(&EditorSession::open(&cut.source_text())))
        );
    }
}

#[test]
fn quoted_crossline_inline_and_nested_containers_keep_their_uncut_meaning() {
    let repeated = quoted_lines(200, |i| format!("ordinary row {i}"));
    for source in [
        format!("> *opens\n{repeated}> closes*\n"),
        format!("> \x60opens\n{repeated}> closes\x60\n"),
        format!("> [opens\n{repeated}> closes](https://example.com)\n"),
        format!("> > nested\n{}", repeated.replace("> ", "> > ")),
        format!("> \x60\x60\x60\n{repeated}> \x60\x60\x60\n"),
        format!("> - item\n{}", repeated.replace("> ", ">   ")),
        format!(" > raw prefix\n{}", repeated.replace("> ", " > ")),
        format!("> first\nlazy line\n{repeated}"),
    ] {
        let cut = EditorSession::open(&source);
        let twin = uncut(|| EditorSession::open(&source));
        assert_eq!(whole(&cut), whole(&twin));
    }
}

#[test]
fn quote_cuts_keep_shifted_prefixes_neighbors_line_endings_and_exact_history() {
    for ending in ["\n", "\r\n"] {
        let quoted: String = (0..400)
            .map(|i| {
                if i % 9 == 0 {
                    format!("> {ending}")
                } else {
                    format!("> row {i} with **bold**{ending}")
                }
            })
            .collect();
        let source = format!(
            "before **plain**{ending}{ending}{quoted}{ending}> neighbor{ending}{ending}end"
        );
        let mut cut = EditorSession::open(&source);
        let mut twin = uncut(|| EditorSession::open(&source));
        assert!(cut.projection.rows.len() > 4);
        for step in 0..24 {
            let text = cut.display_text();
            let at = if step == 0 {
                2
            } else if step % 3 == 0 {
                let (_, _, at) = cut.projection.rows.at(cut.projection.rows.len() / 2);
                at
            } else {
                let mut middle = text.len() / 2;
                while !text.is_char_boundary(middle) {
                    middle -= 1;
                }
                middle + text[middle..].find('\n').unwrap_or(0)
            };
            let selected = range(at, at);
            cut.select(cut.revision(), selected).unwrap();
            twin.select(twin.revision(), selected).unwrap();
            let before = whole(&cut);
            let edits = ["x", "*", "\n", " ", "[", "é", "\n> ", "\n> \n"];
            let key = [
                ParagraphKey::Enter,
                ParagraphKey::Backspace,
                ParagraphKey::Delete,
            ][step % 3];
            let got = if step % 4 == 3 {
                cut.paragraph_key(cut.revision(), selected, key, &mut |_| Ok(()))
                    .map(|change| change.is_some())
            } else {
                cut.replace_action(
                    cut.revision(),
                    selected,
                    edits[step % edits.len()],
                    crate::InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .map(|_| true)
            };
            let wanted = uncut(|| {
                if step % 4 == 3 {
                    twin.paragraph_key(twin.revision(), selected, key, &mut |_| Ok(()))
                        .map(|change| change.is_some())
                } else {
                    twin.replace_action(
                        twin.revision(),
                        selected,
                        edits[step % edits.len()],
                        crate::InputAction::Isolated,
                        &mut |_| Ok(()),
                    )
                    .map(|_| true)
                }
            });
            assert_eq!(got, wanted, "step{step}, ending{ending:?}");
            let after = whole(&cut);
            assert_eq!(after, whole(&twin), "step{step}, ending{ending:?}");
            assert_eq!(
                after,
                uncut(|| whole(&EditorSession::open(&cut.source_text())))
            );
            if got == Ok(true) {
                cut.undo(cut.revision(), &mut |_| Ok(())).unwrap().unwrap();
                uncut(|| twin.undo(twin.revision(), &mut |_| Ok(())))
                    .unwrap()
                    .unwrap();
                assert_eq!(whole(&cut), before);
                assert_eq!(whole(&cut), whole(&twin));
                cut.redo(cut.revision(), &mut |_| Ok(())).unwrap().unwrap();
                uncut(|| twin.redo(twin.revision(), &mut |_| Ok(())))
                    .unwrap()
                    .unwrap();
                assert_eq!(whole(&cut), after);
                assert_eq!(whole(&cut), whole(&twin));
            }
        }
    }
}

fn quote_starts(session: &EditorSession) -> Vec<(usize, bool)> {
    session
        .projection
        .block_lines(range(0, session.display_text().len()))
        .into_iter()
        .filter(|line| line.quote_depth > 0)
        .map(|line| (line.source.start, line.quote_start))
        .collect()
}

#[test]
fn new_quotes_at_preexisting_plain_cuts_keep_their_first_line_identity() {
    let source: String = (0..800)
        .map(|i| format!("ordinary source row {i}\n"))
        .collect();
    for row_index in [1, 8, 20] {
        let mut cut = EditorSession::open(&source);
        let mut twin = uncut(|| EditorSession::open(&source));
        let (_, at, _) = cut.projection.rows.at(row_index);
        let edit = SourceEdit {
            previous_revision: Revision(0),
            revision: Revision(1),
            range: SourceRange {
                start: SourceOffset(at),
                end: SourceOffset(at),
            },
            removed: String::new(),
            inserted: "> ".to_owned(),
        };
        cut.replay(&edit).unwrap();
        uncut(|| twin.replay(&edit)).unwrap();
        assert_eq!(whole(&cut), whole(&twin));
        assert_eq!(quote_starts(&cut), quote_starts(&twin));
        let caret = cut.projection.display_at(at + 2);
        cut.paragraph_key(
            cut.revision(),
            range(caret, caret),
            ParagraphKey::Enter,
            &mut |_| Ok(()),
        )
        .unwrap();
        uncut(|| {
            twin.paragraph_key(
                twin.revision(),
                range(caret, caret),
                ParagraphKey::Enter,
                &mut |_| Ok(()),
            )
        })
        .unwrap();
        assert_eq!(whole(&cut), whole(&twin));
    }
}

#[test]
fn backspace_and_composition_at_a_quote_cut_keep_the_outer_quote_and_history() {
    for ending in ["\n", "\r\n"] {
        let source = format!(
            "before{ending}{ending}{}",
            (0..400)
                .map(|i| format!("> quoted row {i}{ending}"))
                .collect::<String>()
        );
        let mut cut = EditorSession::open(&source);
        let mut twin = uncut(|| EditorSession::open(&source));
        let index = (1..cut.projection.rows.len())
            .find(|&i| {
                let row = cut.projection.rows.at(i).0;
                row.continues && row.blocks.first().is_some_and(|line| line.quote_depth == 1)
            })
            .unwrap();
        let (_, _, at) = cut.projection.rows.at(index);
        assert_eq!(quote_starts(&cut), quote_starts(&twin));
        cut.select(cut.revision(), range(at, at)).unwrap();
        twin.select(twin.revision(), range(at, at)).unwrap();
        cut.paragraph_key(
            cut.revision(),
            range(at, at),
            ParagraphKey::Backspace,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
        uncut(|| {
            twin.paragraph_key(
                twin.revision(),
                range(at, at),
                ParagraphKey::Backspace,
                &mut |_| Ok(()),
            )
        })
        .unwrap()
        .unwrap();
        assert_eq!(whole(&cut), whole(&twin));
        cut.undo(cut.revision(), &mut |_| Ok(())).unwrap().unwrap();
        uncut(|| twin.undo(twin.revision(), &mut |_| Ok(())))
            .unwrap()
            .unwrap();
        assert_eq!(cut.source_text(), source);
        assert_eq!(whole(&cut), whole(&twin));
        let utf16 = cut.display_to_utf16(cut.revision(), range(at, at)).unwrap();
        let marked: Vec<u16> = "日本".encode_utf16().collect();
        cut.compose_utf16(cut.revision(), utf16, &marked).unwrap();
        uncut(|| twin.compose_utf16(twin.revision(), utf16, &marked)).unwrap();
        cut.commit_composition(cut.revision(), None, &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        uncut(|| twin.commit_composition(twin.revision(), None, &mut |_| Ok(())))
            .unwrap()
            .unwrap();
        assert_eq!(whole(&cut), whole(&twin));
        cut.undo(cut.revision(), &mut |_| Ok(())).unwrap().unwrap();
        uncut(|| twin.undo(twin.revision(), &mut |_| Ok(())))
            .unwrap()
            .unwrap();
        assert_eq!(cut.source_text(), source);
        assert_eq!(whole(&cut), whole(&twin));
    }
}

#[test]
fn selected_inline_formats_cross_quote_cuts_without_changing_source_ownership() {
    let source = quoted_lines(400, |i| format!("row {i} with *left* and **right**"));
    let mut cut = EditorSession::open(&source);
    let mut twin = uncut(|| EditorSession::open(&source));
    let (_, _, seam) = cut.projection.rows.at(cut.projection.rows.len() / 2);
    let selected = range(seam - 5, seam + 6);
    cut.select(cut.revision(), selected).unwrap();
    twin.select(twin.revision(), selected).unwrap();
    cut.toggle_format(cut.revision(), crate::InlineFormat::Strike, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    uncut(|| {
        twin.toggle_format(
            twin.revision(),
            crate::InlineFormat::Strike,
            &mut |_| Ok(()),
        )
    })
    .unwrap()
    .unwrap();
    assert_eq!(whole(&cut), whole(&twin));
    cut.undo(cut.revision(), &mut |_| Ok(())).unwrap().unwrap();
    uncut(|| twin.undo(twin.revision(), &mut |_| Ok(())))
        .unwrap()
        .unwrap();
    assert_eq!(cut.source_text(), source);
    assert_eq!(cut.selection(), selected);
    assert_eq!(whole(&cut), whole(&twin));
}
