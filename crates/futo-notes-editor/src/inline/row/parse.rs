//! Parse one source row into display, correspondence and canonical meaning.
use super::*;
use pulldown_cmark::{BrokenLink, Options};

impl Row {
    pub fn parse(source: &str) -> Self {
        Self::parse_with_references(
            source,
            &Arc::new(super::references::References::default()),
            &[],
        )
    }

    pub(crate) fn parse_with_references(
        source: &str,
        references: &Arc<super::references::References>,
        winners: &[super::references::Winner],
    ) -> Self {
        let (definitions, mut reference_work) = super::references::declarations(source, winners);
        let callback_items = std::cell::Cell::new(0);
        let callback_copied = std::cell::Cell::new(0);
        let events: Vec<_> = Parser::new_with_broken_link_callback(
            source,
            Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
            Some(|link: BrokenLink<'_>| {
                callback_items.set(callback_items.get() + 1);
                callback_copied.set(callback_copied.get() + link.reference.len());
                references.broken(link)
            }),
        )
        .into_offset_iter()
        .collect();
        reference_work.items += callback_items.get();
        reference_work.copied += callback_copied.get();
        let mut reference_uses = Vec::new();
        let (blocks, prefixes) = super::blocks::describe(source, &events);
        let mut hidden = vec![false; source.len()];
        for prefix in prefixes {
            hidden[prefix].fill(true);
        }
        let mut spans = Vec::new();
        let mut replacements = Vec::<(Range<usize>, String)>::new();
        let mut in_code = false;
        let mut link = None;
        for (event, range) in events {
            match &event {
                Event::Start(Tag::CodeBlock(_)) => {
                    in_code = true;
                    continue;
                }
                Event::End(pulldown_cmark::TagEnd::CodeBlock) => {
                    in_code = false;
                    continue;
                }
                _ if in_code => continue,
                _ => {}
            }
            match &event {
                Event::Start(Tag::Link {
                    dest_url,
                    title,
                    link_type,
                    id,
                }) => {
                    reference_work.items += 1;
                    let target = if super::references::is_reference(link_type) {
                        reference_work.copied += id.len();
                        references.target(id).cloned()
                    } else {
                        None
                    };
                    let target = target.unwrap_or_else(|| {
                        reference_work.copied += dest_url.len() + title.len();
                        Arc::new(LinkMeaning {
                            destination: dest_url.to_string(),
                            title: (!title.is_empty()).then(|| title.to_string()),
                            reference: None,
                        })
                    });
                    if let Some(key) = &target.reference {
                        reference_uses.push(super::references::ReferenceUse {
                            range: range.clone(),
                            key: key.clone(),
                            image: false,
                        });
                    }
                    link = Some((range.clone(), target, range.start + 1));
                }
                Event::Start(Tag::Image { link_type, id, .. })
                    if super::references::is_reference(link_type) =>
                {
                    reference_work.items += 1;
                    reference_work.copied += id.len();
                    if let Some(target) = references.target(id) {
                        reference_uses.push(super::references::ReferenceUse {
                            range: range.clone(),
                            key: target.reference.as_ref().unwrap().clone(),
                            image: true,
                        });
                    }
                    if let Some((_, _, label_end)) = &mut link {
                        *label_end = (*label_end).max(range.end);
                    }
                }
                Event::End(pulldown_cmark::TagEnd::Link) => {
                    if let Some((whole, destination, label_end)) = link.take() {
                        let label = whole.start + 1..label_end;
                        let span = Span {
                            kind: SpanKind::Link(destination),
                            open: whole.start..label.start,
                            close: label.end..whole.end,
                        };
                        hidden[span.open.clone()].fill(true);
                        hidden[span.close.clone()].fill(true);
                        spans.push(span);
                    }
                }
                _ => {
                    if let Some((_, _, label_end)) = &mut link {
                        *label_end = (*label_end).max(range.end);
                    }
                }
            }
            let format = match event {
                Event::Start(Tag::Strong) => Some((InlineFormat::Bold, 2)),
                Event::Start(Tag::Emphasis) => Some((InlineFormat::Italic, 1)),
                Event::Start(Tag::Strikethrough) => {
                    let width = if source[range.clone()].starts_with("~~") {
                        2
                    } else {
                        1
                    };
                    Some((InlineFormat::Strike, width))
                }
                Event::Code(_) => {
                    let (span, code_replacements) = code_span(source, range.clone());
                    hidden[span.open.clone()].fill(true);
                    hidden[span.close.clone()].fill(true);
                    spans.push(span);
                    replacements.extend(code_replacements);
                    None
                }
                Event::Text(text) => {
                    if text.as_ref() != &source[range.clone()] {
                        replacements.push((range.clone(), text.into_string()));
                    } else if range.start > 0 && source.as_bytes()[range.start - 1] == b'\\' {
                        if let Some(first) = text.chars().next().filter(char::is_ascii_punctuation)
                        {
                            replacements.push((
                                range.start - 1..range.start + first.len_utf8(),
                                first.to_string(),
                            ));
                        }
                    }
                    None
                }
                _ => None,
            };
            if let Some((format, width)) = format {
                let open = range.start..range.start + width;
                let close = range.end - width..range.end;
                hidden[open.clone()].fill(true);
                hidden[close.clone()].fill(true);
                spans.push(Span {
                    kind: SpanKind::Format(format),
                    open,
                    close,
                });
            }
        }
        let (bare, additional_parse) = super::links::bare_links(source);
        // GFM literal URLs own punctuation inside their parser-reported body.
        // CommonMark's independent emphasis pass must not consume that same
        // punctuation as an opener or closer outside the URL interpretation.
        spans.retain(|span| {
            let punctuation = matches!(
                span.kind,
                SpanKind::Format(InlineFormat::Bold | InlineFormat::Italic | InlineFormat::Strike)
            );
            let overlaps = |marker: &Range<usize>| {
                bare.iter()
                    .any(|url| marker.start < url.close.start && url.open.end < marker.end)
            };
            if punctuation && (overlaps(&span.open) || overlaps(&span.close)) {
                hidden[span.open.clone()].fill(false);
                hidden[span.close.clone()].fill(false);
                false
            } else {
                true
            }
        });
        reference_work.items += bare.len();
        reference_work.copied += bare
            .iter()
            .filter_map(|span| match &span.kind {
                SpanKind::Link(target) => {
                    Some(target.destination.len() + target.title.as_ref().map_or(0, String::len))
                }
                _ => None,
            })
            .sum::<usize>();
        spans.extend(bare);
        for definition in definitions.iter().filter(|definition| definition.winner) {
            reference_work.items += 1;
            reference_work.copied += definition.key.as_ref().len();
            if references.used(definition.key.as_ref()) {
                hidden[super::references::hidden_definition(source, definition)].fill(true);
            }
        }
        for block in &blocks {
            if block.empty_comment {
                hidden[block.source.clone()].fill(true);
                continue;
            }
            if let Some(fence) = &block.fence {
                hidden[fence.separator.clone()].fill(true);
            }
            hidden[block.source.start..block.content.start].fill(true);
            let end = source[block.source.clone()]
                .trim_end_matches(['\r', '\n'])
                .len()
                + block.source.start;
            if block.content.end <= end {
                hidden[block.content.end..end].fill(true);
            }
            if block.divider {
                replacements.push((block.content.clone(), "\u{fffc}".into()));
            }
        }
        replacements.sort_by_key(|(r, _)| r.start);
        let mut replacements = replacements.into_iter().peekable();
        let mut display = String::new();
        let mut segments = Vec::new();
        let mut at = 0;
        while at < source.len() {
            let start = at;
            let display_start = display.len();
            if let Some((range, _)) = replacements.peek() {
                if range.start == at {
                    let (range, text) = replacements.next().unwrap();
                    display.push_str(&text);
                    at = range.end;
                    segments.push(Segment {
                        source: start..at,
                        display: display_start..display.len(),
                        identity: false,
                    });
                    continue;
                }
            }
            if hidden[at] {
                at += source[at..].chars().next().unwrap().len_utf8();
            } else {
                at += source[at..].chars().next().unwrap().len_utf8();
                display.push_str(&source[start..at]);
            }
            segments.push(Segment {
                source: start..at,
                display: display_start..display.len(),
                identity: !hidden[start],
            });
        }
        spans.sort_by_key(|span| (span.open.start, std::cmp::Reverse(span.close.end)));
        let mut context: Vec<ContextRun> = Vec::new();
        for (index, block) in blocks.iter().enumerate() {
            // A nonfinal row's synthetic EOF is owned by the next row.
            if block.source.is_empty() && !source.is_empty() {
                continue;
            }
            let transparent_quote = (!block.code
                && !block.empty_comment
                && block.list.as_ref().is_none_or(|list| !list.first)
                && source[block.content.clone()]
                    .bytes()
                    .all(|b| matches!(b, b' ' | b'\t')))
            .then_some(block.quote_depth);
            if let Some(previous) = context.last_mut().filter(|previous| {
                transparent_quote.is_some() && previous.transparent_quote == transparent_quote
            }) {
                previous.source.end = block.source.end;
                previous.last = index;
            } else {
                context.push(ContextRun {
                    source: block.source.clone(),
                    first: index,
                    last: index,
                    transparent_quote,
                });
            }
        }
        let transparent_quote = (context.len() == 1)
            .then(|| context[0].transparent_quote)
            .flatten();
        Self {
            context,
            transparent_quote,
            source_len: source.len(),
            parsed_source_bytes: source.len() + additional_parse + reference_work.parsed,
            definitions,
            reference_uses,
            reference_work,
            literal_links: Vec::new(),
            display,
            segments,
            spans,
            blocks,
        }
    }
}

fn code_span(source: &str, range: Range<usize>) -> (Span, Vec<(Range<usize>, String)>) {
    let raw = &source[range.clone()];
    let width = raw.bytes().take_while(|b| *b == b'`').count();
    let mut start = range.start + width;
    let mut end = range.end - width;
    let normalized = source[start..end]
        .replace("\r\n", " ")
        .replace(['\r', '\n'], " ");
    if normalized.starts_with(' ')
        && normalized.ends_with(' ')
        && normalized.chars().any(|c| c != ' ')
    {
        start += if source[start..end].starts_with("\r\n") {
            2
        } else {
            1
        };
        end -= if source[start..end].ends_with("\r\n") {
            2
        } else {
            1
        };
    }
    let span = Span {
        kind: SpanKind::Format(InlineFormat::Code),
        open: range.start..start,
        close: end..range.end,
    };
    let mut replacements = Vec::new();
    let mut at = start;
    while at < end {
        let ch = source[at..end].chars().next().unwrap();
        if ch == '\r' || ch == '\n' {
            let width = if source[at..end].starts_with("\r\n") {
                2
            } else {
                1
            };
            replacements.push((at..at + width, " ".into()));
            at += width;
        } else {
            at += ch.len_utf8();
        }
    }
    (span, replacements)
}
