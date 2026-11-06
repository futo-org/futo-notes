//! Classify whole-parser regions and prove their continuation seams.
use super::*;

/// One parse finds protected blocks, sealed cuts and outside dependencies.
pub(super) fn analyze(
    source: &str,
    base: usize,
    outside: Outside<'_>,
    protected: &mut Vec<std::ops::Range<usize>>,
    cuts: &mut Vec<(usize, Cut)>,
    starts: &mut Vec<usize>,
) -> (bool, bool) {
    // A paragraph or list continues from outside only without an HTML
    // prefix; a nested list context is the list's own ancestors.
    let context = outside.context.filter(|_| base > 0);
    let html_prefix = base > 0 && context.is_none();
    let continues = outside.continues && (base == 0 || context.is_some());
    let next = outside.next.filter(|_| outside.next_opener.is_none());
    let (mut widen_back, mut widen_forward) = (false, false);
    let mut depth = 0usize;
    let mut first_block = None;
    // The last top-level block, when it is a cut-compatible tail.
    let mut tail = Tail::Other;
    let mut paragraph: Option<Paragraph> = None;
    let mut list: Option<ListScan> = None;
    let mut quote: Option<quote::Quote> = None;
    let mut html = None;
    for (event, range) in Parser::new_ext(source, super::super::parser_options()).into_offset_iter()
    {
        if depth == 0 && matches!(event, Event::Start(Tag::BlockQuote(_))) {
            quote = Some(quote::Quote::new(range.clone()));
        }
        if let Some(quote) = &mut quote {
            quote.observe(source, &event, &range, depth);
        }
        if first_block.is_none() {
            first_block = Some(if context.is_some() {
                depth == 0 && matches!(event, Event::Start(Tag::List(_)))
            } else if html_prefix {
                matches!(
                    event,
                    Event::Start(Tag::HtmlBlock | Tag::CodeBlock(CodeBlockKind::Fenced(_)))
                ) && range.end > base
            } else {
                depth == 0
                    && match &event {
                        Event::Start(Tag::Paragraph | Tag::List(None) | Tag::BlockQuote(_)) => true,
                        Event::Start(Tag::List(Some(number))) => {
                            outside.first_number == Some(*number)
                        }
                        _ => false,
                    }
            });
        }
        match &event {
            Event::Start(tag) if is_block(tag) => {
                if protects(tag) {
                    protected.push(range.clone());
                }
                if depth == 0 {
                    starts.push(range.start);
                    tail = Tail::Other;
                    match tag {
                        Tag::Paragraph => paragraph = Some(Paragraph::new(range.clone())),
                        Tag::List(number) => {
                            list = Some(ListScan::new(range.clone(), number, base))
                        }
                        Tag::HtmlBlock => html = Some((range.clone(), false)),
                        Tag::CodeBlock(CodeBlockKind::Fenced(_)) => {
                            html = Some((range.clone(), true))
                        }
                        _ => {}
                    }
                } else if let Some(open) = list.as_mut() {
                    open.nested(source, tag, depth, range.start);
                }
                if is_container(tag) {
                    depth += 1;
                }
            }
            Event::End(TagEnd::Paragraph) if depth == 0 => {
                if let Some(mut found) = paragraph.take() {
                    found.wikilinks(source);
                    let connected_first = continues && at_line_start(source, found.range.start);
                    let end = found.range.end;
                    let connected_last = next.is_some() && reaches_end(source, end);
                    // An emphasis literal keeps an ordinary paragraph whole;
                    // a table's rows cut around it, and only an edit that can
                    // change some delimiter run reparses the whole table.
                    let table = found.emphasis && is_table(source, &found.range);
                    // Connections at word seams outside the text.
                    let word_first = connected_first && outside.previous.is_some();
                    let word_last = connected_last && !source.ends_with('\n');
                    if found.dangling || !found.depth.is_empty() || found.emphasis && !table {
                        widen_back |= connected_first;
                        widen_forward |= connected_last;
                    } else if found.word_dangling && (word_first || word_last) {
                        widen_back |= word_first;
                        widen_forward |= word_last;
                    } else {
                        if found.emphasis && !outside.neutral {
                            widen_back |= connected_first;
                            widen_forward |= connected_last;
                        }
                        if found.range.len() >= SPLIT_MIN || connected_first || connected_last {
                            // A line cut at a word seam outside the text is long.
                            found.cuts(source, (word_first, word_last), cuts);
                        }
                    }
                    if reaches_end(source, end) {
                        tail = Tail::Paragraph;
                    }
                }
            }
            Event::End(tag) if is_container_end(tag) => {
                depth -= 1;
                if depth == 0 {
                    if let Some(found) = quote.take() {
                        let connected_first = continues && at_line_start(source, found.range.start);
                        let reaches = reaches_end(source, found.range.end);
                        let connected_last = next.is_some() && reaches;
                        if let Some(mut sealed) = found.finish(source) {
                            widen_back |= connected_first && !sealed.first_sealed;
                            if source.len() >= SPLIT_MIN || connected_first || connected_last {
                                cuts.append(&mut sealed.cuts);
                            }
                            if reaches {
                                tail = Tail::Quote(sealed.tail);
                            }
                        } else {
                            widen_back |= connected_first;
                            widen_forward |= connected_last;
                        }
                    }
                    if let Some(mut found) = list.take() {
                        let connected_first = continues && at_line_start(source, found.range.start);
                        let reaches = found.reaches_end(source);
                        let connected_last = next.is_some() && reaches;
                        let cuttable = found.cuttable(source);
                        // A context row's first item must still continue
                        // its list where the context says.
                        if let Some(context) = context.filter(|_| connected_first) {
                            widen_back |=
                                !(cuttable && found.first_continues(context, outside.first_number));
                        }
                        if cuttable {
                            if found.range.len() >= SPLIT_MIN || connected_first || connected_last {
                                found.cuts(cuts);
                            }
                            if reaches {
                                tail = Tail::List(found);
                            }
                        } else {
                            widen_back |= connected_first;
                            widen_forward |= connected_last;
                        }
                    }
                }
            }
            Event::Rule if depth == 0 => {
                starts.push(range.start);
                tail = Tail::Other;
            }
            Event::End(TagEnd::HtmlBlock | TagEnd::CodeBlock) if depth == 0 => {
                if let Some((mut block, fence)) = html.take() {
                    // A fence opener line keeps its indentation, which body
                    // lines strip.
                    if fence {
                        block.start = source[..block.start].rfind('\n').map_or(0, |at| at + 1);
                    }
                    // A fence stays open into the following row only unclosed.
                    let reaches = reaches_end(source, block.end)
                        && (!fence || super::super::unclosed_fence(&source[block.clone()]));
                    let connected = block.start < base || outside.next_opener.is_some() && reaches;
                    // A continued fence closing on the row's first line makes
                    // the preceding row's final line ending its frame.
                    widen_back |= block.start < base
                        && html::closer_line(source, &block, fence) == Some(base);
                    html::cuts(source, block.clone(), (base, fence), connected, cuts);
                    if reaches {
                        tail = Tail::Opened(block.start);
                    }
                }
            }
            _ => {
                if let Some(open) = paragraph.as_mut() {
                    open.inline(source, &event, range);
                } else if let Some(open) = list.as_mut() {
                    open.content(depth);
                }
            }
        }
    }
    if (continues || base > 0) && first_block != Some(true) {
        widen_back = true;
    }
    if let Some(previous) = outside.previous {
        widen_back |= !word::sealed(previous, &source[base..]);
    }
    if let Some(next) = outside.next {
        let sealed = match &tail {
            // The following row keeps its opener only when that line stands.
            Tail::Opened(start) => {
                outside.next_opener == Some(super::super::opener_line(source, *start))
                    && super::super::reaches_into(&source[*start..], next)
            }
            _ if outside.next_opener.is_some() => false,
            Tail::List(found) => found.continued_by(next, outside.next_context),
            Tail::Quote(found) => found.continued_by(next),
            _ if outside.next_context.is_some() => false,
            Tail::Paragraph => {
                seam_after(source, source.len()) && seam_before(next, 0)
                    || word::sealed(source, next)
            }
            Tail::Other => false,
        };
        widen_forward |= !sealed;
    }
    (widen_back, widen_forward)
}

enum Tail {
    /// An open raw HTML or fenced block starting here.
    Opened(usize),
    Paragraph,
    List(ListScan),
    Quote(quote::QuoteTail),
    Other,
}
