//! Frozen complete canonical fence visitor from30b before bounded queries.
use super::*;
use crate::inline::blocks;

fn old_describe(source: &str, events: &[(Event<'_>, Range<usize>)], lines: &mut [BlockLine]) {
    let mut code: Option<(Range<usize>, Option<String>, bool, Vec<Range<usize>>)> = None;
    for (event, range) in events {
        crate::inline::visit_container();
        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                let (language, fenced) = match kind {
                    CodeBlockKind::Fenced(info) => {
                        (info.split_whitespace().next().map(str::to_owned), true)
                    }
                    CodeBlockKind::Indented => (None, false),
                };
                code = Some((range.clone(), language, fenced, Vec::new()));
            }
            Event::Text(_) if code.is_some() => code.as_mut().unwrap().3.push(range.clone()),
            Event::End(TagEnd::CodeBlock) => {
                let (whole, language, fenced, bodies) = code.take().unwrap();
                let first = lines.partition_point(|line| {
                    crate::inline::visit_container();
                    line.source.end <= whole.start
                });
                let last = lines.partition_point(|line| {
                    crate::inline::visit_container();
                    line.source.start < whole.end
                });
                let fence = if fenced {
                    let marker = source.as_bytes()[whole.start];
                    let width = source[whole.clone()]
                        .bytes()
                        .take_while(|&ch| ch == marker)
                        .count();
                    let opener = whole.start..whole.start + width;
                    let body_start = lines[first].source.end;
                    let final_line = &lines[last - 1];
                    let tail =
                        source[final_line.content.clone()].trim_start_matches([' ', '\t', '>']);
                    let close_width = tail.bytes().take_while(|&ch| ch == marker).count();
                    let closed = last > first + 1
                        && !bodies.iter().any(|body| {
                            crate::inline::visit_container();
                            if body.start < final_line.source.end {
                                crate::inline::visit_container();
                                final_line.source.start < body.end
                            } else {
                                false
                            }
                        })
                        && close_width >= width
                        && tail[close_width..].trim().is_empty();
                    let closer = closed.then(|| {
                        let start = final_line.content.end - tail.len();
                        start..start + close_width
                    });
                    let physical_end = if closed {
                        final_line.source.start
                    } else {
                        whole.end
                    };
                    // The final ending terminates code.value in the shipping
                    // CommonMark schema; preceding endings are editable text.
                    let ending = if source[body_start..physical_end].ends_with("\r\n") {
                        2
                    } else {
                        usize::from(source[body_start..physical_end].ends_with('\n'))
                    };
                    let body_end = physical_end - ending;
                    Some(Fence {
                        separator: body_end..physical_end,
                        whole: whole.clone(),
                        body: body_start..body_end,
                        opener,
                        closer,
                        marker,
                        width,
                    })
                } else {
                    None
                };
                for line in &mut lines[first..last] {
                    crate::inline::visit_container();
                    line.code = true;
                    line.code_language.clone_from(&language);
                    line.fence.clone_from(&fence);
                    let start = bodies
                        .iter()
                        .filter(|body| {
                            crate::inline::visit_container();
                            if body.start < line.source.end {
                                crate::inline::visit_container();
                                line.source.start < body.end
                            } else {
                                false
                            }
                        })
                        .map(|body| {
                            crate::inline::visit_container();
                            body.start.max(line.source.start)
                        })
                        .min_by(|a, b| {
                            crate::inline::visit_container();
                            a.cmp(b)
                        });
                    // Only a closer with following source supplies an inter-block
                    // break; its delimiter and the body frame ending stay hidden.
                    line.content = match start {
                        // A semantically empty row's Text event can begin at
                        // LF inside CRLF. Empty content ends before the entire
                        // physical ending; the parser-attributed prefix still
                        // includes any stripped fence indentation.
                        Some(start) if start > line.content.end => {
                            line.content.end..line.content.end
                        }
                        Some(start) => start..line.content.end,
                        None if fence.as_ref().is_some_and(|fence| {
                            line.source.end < source.len()
                                && fence.closer.as_ref().is_some_and(|close| {
                                    line.source.start <= close.start && close.end <= line.source.end
                                })
                        }) =>
                        {
                            line.content.end..line.content.end
                        }
                        None => line.source.end..line.source.end,
                    };
                    line.bodies[0].content = line.content.clone();
                }
                // An unmatched fence owns EOF, including the synthetic row
                // after its terminal ending. It must not introduce a foreign
                // prose owner at the editable body-end caret.
                if let Some(fence) =
                    fence.filter(|fence| fence.closer.is_none() && fence.whole.end == source.len())
                {
                    let depth = lines[last - 1].quote_depth;
                    if let Some(terminal) = lines
                        .get_mut(last)
                        .filter(|line| line.source.is_empty() && line.source.start == source.len())
                    {
                        terminal.code = true;
                        terminal.code_language.clone_from(&language);
                        terminal.quote_depth = depth;
                        terminal.fence = Some(fence);
                    }
                }
            }
            _ => {}
        }
    }
}

fn sources() -> Vec<String> {
    let mut sources = Vec::new();
    for data in [
        include_str!("../../tests/fixtures/list-actions.json"),
        include_str!("../../tests/fixtures/list-shortcuts.json"),
        include_str!("../../tests/fixtures/list-staging.json"),
        include_str!("../../tests/fixtures/nested-containers.json"),
        include_str!("../../tests/fixtures/container-commands.json"),
        include_str!("../../tests/fixtures/list-header-commands.json"),
        include_str!("../../tests/fixtures/prefix-frame-commands.json"),
        include_str!("../../tests/fixtures/structural-seams.json"),
        include_str!("../../tests/fixtures/fence-physical-rows.json"),
    ] {
        let cases: serde_json::Value = serde_json::from_str(data).unwrap();
        for case in cases.as_array().unwrap() {
            for key in ["source", "expected", "expectedSource"] {
                if let Some(raw) = case[key].as_str() {
                    sources.push(raw.to_owned());
                }
            }
            if let Some(history) = case["undoSources"].as_array() {
                sources.extend(history.iter().map(|s| s.as_str().unwrap().to_owned()));
            }
        }
    }
    assert_eq!(sources.len(), 506);
    for eol in ["\n", "\r\n"] {
        for outer in ["", "> ", "> > "] {
            for list in ["", "- ", "1000.\t"] {
                for leaf in ["", " ", "  ", "   "] {
                    for blank in ["", " ", "  ", "   ", "\t", " \t"] {
                        for ending in ["", "\n", "\n```", "\n`````  ", "\n- outside"] {
                            let indent = if list.is_empty() {
                                0
                            } else if list == "- " {
                                2
                            } else {
                                8
                            };
                            let prefix = format!("{outer}{}", " ".repeat(indent));
                            let raw = format!("{outer}{list}{leaf}````Rust info\n{prefix}{leaf}a\n{prefix}{blank}\n{prefix}{leaf}b{ending}");
                            sources.push(raw.replace('\n', eol));
                        }
                    }
                }
            }
        }
    }
    sources
}

#[test]
fn canonical_fence_ranges_and_every_block_field_match_the_frozen_visitor() {
    let sources = sources();
    for raw in &sources {
        let events = crate::inline::row::source_events(raw);
        let mut bodies: Vec<Range<usize>> = Vec::new();
        let mut code = false;
        for (event, at) in &events {
            match event {
                Event::Start(Tag::CodeBlock(_)) => {
                    code = true;
                    bodies.clear();
                }
                Event::Text(_) if code => {
                    if let Some(previous) = bodies.last() {
                        assert!(
                            previous.start <= at.start && previous.end <= at.end,
                            "canonical body axes are monotonic: {previous:?}, {at:?}, {raw:?}"
                        );
                    }
                    bodies.push(at.clone());
                }
                Event::End(TagEnd::CodeBlock) => code = false,
                _ => {}
            }
        }
        // The actual canonical block constructor supplies untouched initial
        // physical ranges, prefixes, lists, quotes and heading attribution.
        let (old, old_prefix) = blocks::describe_with_fences(raw, &events, old_describe);
        let (new, new_prefix) = blocks::describe(raw, &events);
        assert_eq!(format!("{old:?}"), format!("{new:?}"), "{raw:?}");
        assert_eq!(old_prefix, new_prefix, "{raw:?}");
        for origin in [0, 61] {
            let old = old
                .iter()
                .cloned()
                .map(|mut b| {
                    b.shift(origin);
                    b
                })
                .collect::<Vec<_>>();
            let new = new
                .iter()
                .cloned()
                .map(|mut b| {
                    b.shift(origin);
                    b
                })
                .collect::<Vec<_>>();
            assert_eq!(
                format!("{old:?}"),
                format!("{new:?}"),
                "shifted{origin}: {raw:?}"
            );
        }
    }
}
