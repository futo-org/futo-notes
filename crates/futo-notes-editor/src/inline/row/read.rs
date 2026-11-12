//! Rows read by the line reader. A row is one line, except the leading front
//! matter, which is one row. Each row keeps the carry it was read from, so a
//! re-read can start at any row and stop where the carry settles.
use super::*;
use crate::inline::blocks::{BlockLine, HeadingSyntax, PhysicalLine};
use crate::inline::lists::ListLine;
use crate::lines::{self, Carry, FenceRole, FrontMatterRole, Kind, Line, SpanKind as Mark};

/// The rows of `text`, read from `carry`, which ends up as the carry after
/// them. `text` holds whole lines. `ends_note` says whether `text` runs to
/// the note's end, where a final line ending opens one more, empty line.
pub(crate) fn read_rows(text: &str, carry: &mut Carry, ends_note: bool) -> Vec<Row> {
    let mut rows = Vec::new();
    let mut at = 0;
    loop {
        let before = carry.clone();
        let line = lines::block::read_line(carry, text, at);
        let mut lines = vec![line];
        if matches!(lines[0].kind, Kind::FrontMatter(FrontMatterRole::Open)) {
            while carry.front_matter && lines.last().unwrap().end() < text.len() {
                let next = lines::block::read_line(carry, text, lines.last().unwrap().end());
                lines.push(next);
            }
        }
        let end = lines.last().unwrap().end();
        let last = end >= text.len();
        if last && ends_note && lines.last().unwrap().ending > 0 {
            // The empty line after a final line ending belongs to this row.
            let mut after = carry.clone();
            let empty = lines::block::read_line(&mut after, text, end);
            lines.push(empty);
            *carry = after;
        }
        rows.push(Row::read(&text[at..end], &lines, at, before));
        if last {
            return rows;
        }
        at = end;
    }
}

/// One row holding every line of `text`, read with no lines above it: the
/// planner checks a candidate source against this before accepting it.
pub(crate) fn read_candidate(text: &str) -> Row {
    let mut carry = Carry::default();
    let mut lines = Vec::new();
    let mut at = 0;
    loop {
        let line = lines::block::read_line(&mut carry, text, at);
        let last = line.ending == 0;
        at = line.end();
        lines::block::place(&mut lines, line);
        if last {
            break;
        }
    }
    Row::read(text, &lines, 0, Carry::default())
}

impl Row {
    /// The row for `lines`, whose offsets start at `base` in the text that
    /// `source` (the row's own text) was cut from.
    fn read(source: &str, lines: &[Line], base: usize, carry: Carry) -> Self {
        let local = |range: &Range<usize>| range.start - base..range.end - base;
        let mut hidden = vec![false; source.len()];
        let mut replacements: Vec<(Range<usize>, String)> = Vec::new();
        let mut spans = Vec::new();
        let mut images = Vec::new();
        let mut isolated = Vec::new();
        let mut blocks = Vec::new();
        let metadata = matches!(lines[0].kind, Kind::FrontMatter(_));
        if metadata {
            blocks.push(front_matter(source, lines, base, &mut hidden));
        }
        for line in lines.iter().filter(|_| !metadata) {
            let range = local(&line.range);
            let whole = range.start..range.end + line.ending;
            let mut block = block_line(source, line, base);
            match &line.kind {
                Kind::Fence { role, language, .. } => {
                    block.code = true;
                    block.code_language = language
                        .as_ref()
                        .map(|language| source[local(language)].to_owned())
                        .or_else(|| carry_language(&carry));
                    if *role == FenceRole::Code {
                        isolated.push(range.clone());
                    } else {
                        hidden[whole].fill(true);
                        block.content = range.start..range.start;
                    }
                }
                Kind::Divider => {
                    replacements.push((range.clone(), "\u{fffc}".into()));
                    block.divider = true;
                    block.content = range.clone();
                }
                _ => {
                    hidden[local(&line.marker)].fill(true);
                    let text = &source[range.clone()];
                    let marks = lines::line_spans(text, &shifted(line, line.range.start));
                    for mark in marks {
                        let shift = |r: &Range<usize>| r.start + range.start..r.end + range.start;
                        let (whole, open, close) =
                            (shift(&mark.range), shift(&mark.open), shift(&mark.close));
                        match mark.kind {
                            Mark::Bold | Mark::Italic | Mark::Strike | Mark::Code => {
                                let format = match mark.kind {
                                    Mark::Bold => InlineFormat::Bold,
                                    Mark::Italic => InlineFormat::Italic,
                                    Mark::Strike => InlineFormat::Strike,
                                    _ => {
                                        isolated.push(whole.clone());
                                        InlineFormat::Code
                                    }
                                };
                                hidden[open.clone()].fill(true);
                                hidden[close.clone()].fill(true);
                                spans.push(Span {
                                    kind: SpanKind::Format(format),
                                    open,
                                    close,
                                });
                            }
                            Mark::Link { destination, title } => {
                                hidden[open.clone()].fill(true);
                                hidden[close.clone()].fill(true);
                                spans.push(Span {
                                    kind: SpanKind::Link(Arc::new(LinkMeaning {
                                        destination,
                                        title,
                                        reference: None,
                                    })),
                                    open,
                                    close,
                                });
                            }
                            Mark::Url { destination } => {
                                if !open.is_empty() {
                                    isolated.push(whole.clone());
                                }
                                hidden[open.clone()].fill(true);
                                hidden[close.clone()].fill(true);
                                spans.push(Span {
                                    kind: SpanKind::Link(LinkMeaning::bare(destination)),
                                    open,
                                    close,
                                });
                            }
                            Mark::Image {
                                alt,
                                destination,
                                title,
                            } => images.push(crate::inline::images::RowImage {
                                alt: source[shift(&alt)].to_owned(),
                                source: whole,
                                meaning: Arc::new(LinkMeaning {
                                    destination,
                                    title,
                                    reference: None,
                                }),
                            }),
                            Mark::Escape => {
                                replacements.push((
                                    whole.clone(),
                                    source[whole.start + 1..whole.end].to_owned(),
                                ));
                            }
                            Mark::Wikilink { .. } | Mark::Tag => {}
                        }
                    }
                }
            }
            blocks.push(block);
        }
        replacements.sort_by_key(|(range, _)| range.start);
        let mut replacements = replacements.into_iter().peekable();
        let mut display = String::new();
        let mut segments = Vec::new();
        let mut table_scan = crate::table::ScanBuilder::new(source);
        let mut at = 0;
        while at < source.len() {
            let start = at;
            let display_start = display.len();
            if replacements
                .peek()
                .is_some_and(|(range, _)| range.start == at)
            {
                let (range, text) = replacements.next().unwrap();
                display.push_str(&text);
                for (offset, ch) in source[range.clone()].char_indices() {
                    table_scan.observe(range.start + offset, ch);
                }
                at = range.end;
                segments.push(Segment {
                    source: start..at,
                    display: display_start..display.len(),
                    identity: false,
                });
                continue;
            }
            let ch = source[at..].chars().next().unwrap();
            table_scan.observe(at, ch);
            at += ch.len_utf8();
            if !hidden[start] {
                display.push_str(&source[start..at]);
            }
            segments.push(Segment {
                source: start..at,
                display: display_start..display.len(),
                identity: !hidden[start],
            });
        }
        let (table_scan, table_read) = table_scan.finish();
        spans.sort_by_key(|span| (span.open.start, std::cmp::Reverse(span.close.end)));
        let (wikilinks, wikilink_mask) =
            crate::inline::wikilinks::scan(source, &isolated, &segments);
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
            metadata,
            opener: None,
            context: None,
            context_ends: Vec::new(),
            tail_chain: Vec::new(),
            source_len: source.len(),
            pipes: source.contains('|'),
            table_scan,
            parsed_source_bytes: source.len() + table_read,
            definitions: Vec::new(),
            reference_uses: Vec::new(),
            reference_work: Default::default(),
            literal_links: Vec::new(),
            literal_delimiters: Vec::new(),
            display,
            segments,
            spans,
            blocks,
            carry,
        }
    }
}

/// `line` with its offsets moved back by `by`.
fn shifted(line: &Line, by: usize) -> Line {
    let back = |range: &Range<usize>| range.start - by..range.end - by;
    let mut line = line.clone();
    line.range = back(&line.range);
    line.marker = back(&line.marker);
    line.content = back(&line.content);
    line
}

fn carry_language(carry: &Carry) -> Option<String> {
    carry
        .fence
        .as_ref()
        .and_then(|fence| fence.language.clone())
}

/// The front matter row: its `---` lines are hidden and the lines between
/// show as one inert metadata block.
fn front_matter(source: &str, lines: &[Line], base: usize, hidden: &mut [bool]) -> BlockLine {
    let local = |range: &Range<usize>| range.start - base..range.end - base;
    let opener = lines[0].end() - base;
    hidden[..opener].fill(true);
    let closed = lines
        .iter()
        .rposition(|line| matches!(line.kind, Kind::FrontMatter(FrontMatterRole::Close)));
    let value_end = match closed {
        Some(index) => {
            let close = local(&lines[index].range).start;
            hidden[close..].fill(true);
            close
        }
        None => source.len(),
    };
    let value = &source[opener..value_end];
    let ending = value
        .strip_suffix('\n')
        .map_or(0, |rest| 1 + usize::from(rest.ends_with('\r')));
    let content_end = value_end - ending;
    BlockLine {
        source: 0..source.len(),
        content: opener..content_end,
        metadata: true,
        bodies: vec![PhysicalLine {
            source: 0..source.len(),
            content: opener..content_end,
        }],
        ..BlockLine::default()
    }
}

/// The block a line is, with offsets in its row.
fn block_line(source: &str, line: &Line, base: usize) -> BlockLine {
    let local = |range: &Range<usize>| range.start - base..range.end - base;
    let range = local(&line.range);
    let whole = range.start..range.end + line.ending;
    let content = local(&line.content);
    let marker = local(&line.marker);
    let width =
        |text: &str| -> usize { text.chars().map(|ch| if ch == '\t' { 4 } else { 1 }).sum() };
    let (list, task, in_list) = match &line.kind {
        Kind::List {
            indent,
            text,
            ordered,
            task,
        } => {
            let text = local(text);
            let marker_column = width(&source[range.start..text.start]);
            let item = ListLine {
                marker: text.clone(),
                owner: whole.clone(),
                item: whole.clone(),
                outer_item: whole.clone(),
                ordinal: ordered
                    .then(|| source[text.start..text.end - 1].parse().ok())
                    .flatten(),
                // One-line items have no nesting; the line's own indent is
                // what a renderer draws.
                depth: 1,
                checked: *task,
                first: true,
                indent: *indent,
                marker_column,
                content_column: marker_column + text.len() + 1,
                previous_content_column: None,
                parent_marker_column: None,
                parent_content_column: None,
                quote_depth: line.quote,
            };
            let task = task.map(|_| marker.end - 4..marker.end - 1);
            (Some(item), task, true)
        }
        _ => (None, None, false),
    };
    let heading = match line.kind {
        Kind::Heading { level } => level,
        _ => 0,
    };
    let paragraph_text =
        matches!(line.kind, Kind::Plain { .. } | Kind::List { .. }) && !content.is_empty();
    BlockLine {
        source: whole.clone(),
        content: content.clone(),
        heading,
        heading_syntax: if heading > 0 {
            HeadingSyntax::Atx
        } else {
            HeadingSyntax::None
        },
        quote_depth: line.quote,
        quote_start: line.quote > 0,
        divider: false,
        code: false,
        metadata: false,
        html: false,
        paragraph_text,
        list,
        task,
        in_list,
        code_language: None,
        fence: None,
        bodies: vec![PhysicalLine {
            source: whole,
            content,
        }],
        underline: None,
    }
}
