//! Parse one source row into display, correspondence and canonical meaning.
use super::*;
use pulldown_cmark::BrokenLink;

impl Row {
    pub(crate) fn parse_with_references(
        source: &str,
        references: &Arc<crate::inline::references::References>,
        winners: &[crate::inline::references::Winner],
    ) -> Self {
        let (definitions, mut reference_work) =
            crate::inline::references::declarations(source, winners);
        let callback_items = std::cell::Cell::new(0);
        let callback_copied = std::cell::Cell::new(0);
        let events: Vec<_> = Parser::new_with_broken_link_callback(
            source,
            super::parser_options(),
            Some(|link: BrokenLink<'_>| {
                callback_items.set(callback_items.get() + 1);
                callback_copied.set(callback_copied.get() + link.reference.len());
                references.broken(link)
            }),
        )
        .into_offset_iter()
        .map(|(event, range)| {
            let range = item_line_start(source, &event, range);
            (event, range)
        })
        .collect();
        reference_work.items += callback_items.get();
        reference_work.copied += callback_copied.get();
        let mut reference_uses = Vec::new();
        let (blocks, prefixes) = crate::inline::blocks::describe(source, &events);
        let tail_chain = tail_chain(source.len(), &events);
        let mut hidden = vec![false; source.len()];
        for prefix in prefixes {
            hidden[prefix].fill(true);
        }
        let mut spans = Vec::new();
        let mut replacements = Vec::<(Range<usize>, String)>::new();
        let mut in_code = false;
        let mut link = None;
        // Open images (an alt may hold another image): whole source, meaning and
        // the furthest alt-text byte seen so far.
        let mut open_images: Vec<(Range<usize>, Arc<LinkMeaning>, usize)> = Vec::new();
        let mut images = Vec::new();
        let mut isolated = Vec::new();
        for (event, range) in events {
            if matches!(
                event,
                Event::Start(Tag::CodeBlock(_) | Tag::HtmlBlock)
                    | Event::Code(_)
                    | Event::Html(_)
                    | Event::InlineHtml(_)
            ) {
                isolated.push(range.clone());
            }
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
                Event::Start(Tag::Image {
                    link_type,
                    dest_url,
                    title,
                    id,
                }) => {
                    let target = if crate::inline::references::is_reference(link_type) {
                        references.target(id).cloned()
                    } else {
                        None
                    };
                    let meaning = target.unwrap_or_else(|| {
                        Arc::new(LinkMeaning {
                            destination: dest_url.to_string(),
                            title: (!title.is_empty()).then(|| title.to_string()),
                            reference: None,
                        })
                    });
                    let mut whole = range.clone();
                    if matches!(
                        link_type,
                        pulldown_cmark::LinkType::Collapsed
                            | pulldown_cmark::LinkType::CollapsedUnknown
                    ) && source.get(whole.end..whole.end + 2) == Some("[]")
                    {
                        whole.end += 2;
                    }
                    open_images.push((whole, meaning, range.start + 2));
                }
                Event::End(pulldown_cmark::TagEnd::Image) => {
                    if let Some((whole, meaning, label_end)) = open_images.pop() {
                        if let Some(parent) = open_images.last_mut() {
                            parent.2 = parent.2.max(whole.end);
                        }
                        images.push(crate::inline::images::RowImage {
                            alt: source[whole.start + 2..label_end].to_owned(),
                            source: whole,
                            meaning,
                        });
                    }
                }
                _ => {
                    if let Some(open) = open_images.last_mut() {
                        open.2 = open.2.max(range.end);
                    }
                }
            }
            match &event {
                Event::Start(Tag::Link {
                    dest_url,
                    title,
                    link_type,
                    id,
                }) => {
                    reference_work.items += 1;
                    let target = if crate::inline::references::is_reference(link_type) {
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
                    // Pulldown consumes a collapsed tail but reports the
                    // label-only source extent for this canonical link type.
                    // Include those parser-owned bytes in hidden correspondence.
                    let mut whole = range.clone();
                    if matches!(
                        link_type,
                        pulldown_cmark::LinkType::Collapsed
                            | pulldown_cmark::LinkType::CollapsedUnknown
                    ) {
                        debug_assert_eq!(source.get(whole.end..whole.end + 2), Some("[]"));
                        whole.end += 2;
                    }
                    if let Some(key) = &target.reference {
                        reference_uses.push(crate::inline::references::ReferenceUse {
                            range: whole.clone(),
                            key: key.clone(),
                            image: false,
                        });
                    }
                    link = Some((whole, target, range.start + 1));
                }
                Event::Start(Tag::Image { link_type, id, .. })
                    if crate::inline::references::is_reference(link_type) =>
                {
                    reference_work.items += 1;
                    reference_work.copied += id.len();
                    if let Some(target) = references.target(id) {
                        reference_uses.push(crate::inline::references::ReferenceUse {
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
        let (bare, read) = crate::inline::links::bare_links(source);
        let additional_parse = read.parsed;
        reference_work.items += read.items;
        reference_work.copied += read.copied;
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
        spans.extend(bare);
        for definition in definitions.iter().filter(|definition| definition.winner) {
            reference_work.items += 1;
            reference_work.copied += definition.key.as_ref().len();
            if references.used(definition.key.as_ref()) {
                hidden[crate::inline::references::hidden_definition(source, definition)].fill(true);
            }
        }
        for block in &blocks {
            if block.empty_comment {
                hidden[block.source.clone()].fill(true);
                continue;
            }
            if let Some(fence) = &block.fence {
                // Retain the terminal boundary of an unmatched container fence.
                if fence.closer.is_some() || fence.whole.end == source.len() {
                    hidden[fence.separator.clone()].fill(true);
                }
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
        let (wikilinks, wikilink_mask) =
            crate::inline::wikilinks::scan(source, &isolated, &segments);
        // Kept only where a link could be typed, so completion can refuse an
        // unfinished `[[` inside code or HTML exactly as a finished link would.
        let isolated = if wikilinks.is_empty() && !source.contains("[[") {
            Vec::new()
        } else {
            isolated
        };
        images.sort_by_key(|image: &crate::inline::images::RowImage| image.source.start);
        Self {
            images,
            wikilinks,
            wikilink_mask,
            wikilink_isolated: isolated,
            guarded_words: Vec::new(),
            typed_inputs: Vec::new(),
            continues: false,
            mid_line: false,
            through: false,
            metadata: false,
            opener: None,
            context: None,
            context_ends: Vec::new(),
            tail_chain,
            source_len: source.len(),
            pipes: source.contains('|'),
            table_scan: crate::table::RowScan::new(source),
            parsed_source_bytes: source.len() * 2 + additional_parse + reference_work.parsed,
            definitions,
            reference_uses,
            reference_work,
            literal_links: Vec::new(),
            literal_delimiters: Vec::new(),
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

/// The start of each item open at the end of `len` source bytes (depth 1
/// first) and of the list holding it.
fn tail_chain(len: usize, events: &[(Event<'_>, Range<usize>)]) -> Vec<(usize, usize)> {
    let mut lists: Vec<usize> = Vec::new();
    let mut chain: Vec<(usize, usize, usize)> = Vec::new();
    for (event, range) in events {
        match event {
            Event::Start(Tag::List(_)) => lists.push(range.start),
            Event::End(pulldown_cmark::TagEnd::List(_)) => {
                lists.pop();
            }
            Event::Start(Tag::Item) if range.end >= len => {
                if let Some(&owner) = lists.last() {
                    chain.truncate(lists.len() - 1);
                    chain.push((range.start, owner, lists.len()));
                }
            }
            _ => {}
        }
    }
    chain
        .into_iter()
        .enumerate()
        .take_while(|(index, (.., depth))| index + 1 == *depth)
        .map(|(_, (item, owner, _))| (item, owner))
        .collect()
}

/// A list or item opened by a tab-indented marker after another item's last
/// block (an ATX heading, a closed fence) is reported by pulldown-cmark from
/// the line ending before it. It starts on its own line: from there every
/// line-based reader attributes it to the line its marker is on.
fn item_line_start(source: &str, event: &Event<'_>, range: Range<usize>) -> Range<usize> {
    let item = matches!(
        event,
        Event::Start(Tag::List(_) | Tag::Item)
            | Event::End(pulldown_cmark::TagEnd::List(_) | pulldown_cmark::TagEnd::Item)
    );
    let ending = match source.as_bytes().get(range.start) {
        Some(b'\n') => 1,
        Some(b'\r') if source.as_bytes().get(range.start + 1) == Some(&b'\n') => 2,
        _ => 0,
    };
    if item && ending > 0 && range.start + ending <= range.end {
        range.start + ending..range.end
    } else {
        range
    }
}
