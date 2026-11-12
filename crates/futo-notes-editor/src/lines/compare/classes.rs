#![allow(clippy::too_many_lines)] // One long table of classes.
//! Which spec rule explains a line whose reading changed.
use super::*;
use std::ops::Range;

pub(super) fn new_shape(line: &Line) -> Shape {
    match &line.kind {
        Kind::Plain { .. } => Shape::Plain,
        Kind::Blank => Shape::Blank,
        Kind::Heading { level } => Shape::Heading(*level),
        Kind::List { depth, .. } => Shape::List(*depth),
        Kind::Divider => Shape::Divider,
        Kind::FrontMatter(_) => Shape::FrontMatter,
        Kind::Fence {
            role: FenceRole::Code,
            ..
        } => Shape::Code,
        Kind::Fence { .. } => Shape::Fence,
        Kind::Table { role, .. } => Shape::Table(*role),
    }
}

pub(super) fn kind_name(shape: &Shape) -> &'static str {
    match shape {
        Shape::Blank => "blank",
        Shape::Plain => "plain",
        Shape::Heading(_) => "heading",
        Shape::List(_) => "list item",
        Shape::Divider => "divider",
        Shape::Code => "code",
        Shape::Fence => "fence",
        Shape::FrontMatter => "front matter",
        Shape::Table(_) => "table",
        Shape::Html => "html",
        Shape::Hidden => "hidden",
    }
}

/// The class of a line whose block reading changed: `rule — what`, or
/// `UNPREDICTED — …` when no spec rule explains it.
pub(super) fn block_class(old: &Old, text: &str, line: &Line, source: &str) -> String {
    let before = old_shape(old, text);
    let after = new_shape(line);
    let trimmed = text.trim_start_matches([' ', '\t']);
    let indent = text.len() - trimmed.len();
    let own_text_after_quotes = {
        let mut rest = text;
        while let Some(stripped) = rest.trim_start().strip_prefix('>') {
            rest = stripped;
        }
        rest.trim_start()
    };
    let new_code = matches!(after, Shape::Code | Shape::Fence);
    let old_code = matches!(before, Shape::Code | Shape::Fence);
    if let Kind::List { .. } = line.kind {
        let content = &source[line.content.clone()];
        if old.quote > line.quote && content.starts_with('>') {
            return "Stacking markers — `- > b` is a bullet with the text `> b`".into();
        }
        if old_code && (content.starts_with("```") || content.starts_with("~~~")) {
            return "Stacking markers — a fence after a list marker is the item's text".into();
        }
    }
    if old.metadata != matches!(line.kind, Kind::FrontMatter(_)) {
        return if matches!(line.kind, Kind::FrontMatter(_)) {
            "Front matter — `---` on line 1 with no closing `---` runs to the end".into()
        } else {
            format!(
                "UNPREDICTED — engine front matter, now {}",
                kind_name(&after)
            )
        };
    }
    if old.setext_text {
        return "Differences row 1 — setext heading text is a plain line".into();
    }
    if old.setext_underline {
        return "Differences row 1 — setext underline is a divider, plain line or bullet".into();
    }
    if old.html && !matches!(after, Shape::Code | Shape::Fence) {
        return "Not in version 1 — raw HTML block lines are plain text".into();
    }
    if old.footnote && !old.fenced {
        return "Not in version 1 — footnote definition lines are literal text".into();
    }
    if before == Shape::Hidden {
        return "Not in version 1 — reference definitions show as literal text".into();
    }
    if old.indented_code && !old.fenced {
        return match after {
            Shape::Code | Shape::Fence => {
                "Code — a fence the indented code block hid now opens".into()
            }
            _ => "Differences row 6 — indented code is a plain line or list nesting".into(),
        };
    }
    if new_code != old_code || (new_code && before != after) {
        let opener = source[..line.range.start]
            .lines()
            .rev()
            .find(|l| {
                let t = l.trim_start_matches([' ', '\t', '>']).trim_start();
                t.starts_with("```") || t.starts_with("~~~")
            })
            .unwrap_or("");
        return if text.trim_start().starts_with('>') || opener.trim_start().starts_with('>') {
            "Code — a fence is not recognised after `>`".into()
        } else if new_code && !old_code {
            "Code — a fence runs to its closing line or the note's end, not its container's end"
                .into()
        } else if old_code && !new_code && trimmed.starts_with(['`', '~']) {
            "Code — a closing fence needs the opening character, at least as many".into()
        } else {
            format!(
                "UNPREDICTED — code {} → {}",
                kind_name(&before),
                kind_name(&after)
            )
        };
    }
    if old.quote != line.quote {
        let q = text.trim_start();
        return if line.quote < old.quote && !q.starts_with('>') && old.continuation {
            "Differences row 5 — a plain line under a quote is its own, unquoted line".into()
        } else if line.quote < old.quote && indent > 0 && q.starts_with('>') {
            "Quotes — ASK: an indented `>` line is plain (quotes read only at column 0)".into()
        } else if line.quote < old.quote && q.starts_with('>') {
            "Differences row 10 — `>text` with no space is plain".into()
        } else if line.quote < old.quote && old.lists > 0 && !old.item_start {
            "Differences row 4 — a line under a bullet is its own line (quote inside an item)"
                .into()
        } else {
            format!("UNPREDICTED — quote depth {} → {}", old.quote, line.quote)
        };
    }
    match (&before, &after) {
        (Shape::Table(_), Shape::Plain) => {
            return if !trimmed.starts_with('|') {
                "Differences row 11 — a table row with no leading pipe is plain".into()
            } else if indent > 0 || line.quote > 0 {
                "Tables — read only at the top level".into()
            } else {
                "Tables — a header needs a delimiter row of dashes under a pipe line".into()
            };
        }
        (_, Shape::Table(_)) if before != after => {
            let header_cells = |row: &str| super::table::cells(row.trim_end()).len();
            let mismatch = match &line.kind {
                Kind::Table { columns, .. } => source[line.range.end..]
                    .lines()
                    .nth(1)
                    .zip(Some(*columns))
                    .is_some_and(|(next, columns)| {
                        matches!(
                            line.kind,
                            Kind::Table {
                                role: TableRole::Header,
                                ..
                            }
                        ) && header_cells(next) != columns
                    }),
                _ => false,
            };
            return if mismatch
                || matches!(
                    line.kind,
                    Kind::Table {
                        role: TableRole::Delimiter | TableRole::Row,
                        ..
                    }
                ) && !old.continuation
                    && old.lists == 0
            {
                "Tables — ASK: a delimiter row whose cell count differs from the header still makes a table".into()
            } else if source[line.range.end..]
                .lines()
                .nth(1)
                .is_some_and(|next| next.contains('\t') && delimiter_like(next))
            {
                "Tables — a delimiter row padded with tabs is a delimiter row (pulldown-cmark refused it)".into()
            } else if old.continuation || old.lists > 0 {
                "When one line affects another 4/5 — a table is read by its own lines, even under text or a bullet".into()
            } else {
                format!("UNPREDICTED — {} → table", kind_name(&before))
            };
        }
        (Shape::Heading(_), Shape::Plain) => {
            return if indent > 0 {
                "Headings start at column 0 — an indented `#` line is plain".into()
            } else if own_text_after_quotes.trim_end().bytes().all(|b| b == b'#') {
                "Differences row 9 — `#` with nothing after is plain".into()
            } else {
                "UNPREDICTED — heading → plain".into()
            };
        }
        (Shape::Divider, Shape::List(_)) => {
            return "Differences row 12 — `- - -` is a bullet".into();
        }
        (Shape::Divider, Shape::Plain) => {
            return if indent > 0 {
                "Headings and dividers start at column 0 — an indented divider is plain".into()
            } else if line.quote > 0 || old.lists > 0 {
                "Stacking markers — a divider is not read after `>` or inside a list item".into()
            } else if text.trim_end() != text {
                "Blocks — a divider has nothing else on its line (trailing whitespace)".into()
            } else if text.contains([' ', '\t']) {
                "Blocks — a divider has no spaces in it (`*** ** *`)".into()
            } else {
                "UNPREDICTED — divider → plain".into()
            };
        }
        (Shape::List(_), Shape::Plain) | (Shape::List(_), Shape::Blank) => {
            let bare = own_text_after_quotes.trim_end();
            let marker_only = bare.len() <= 3
                && (matches!(bare, "-" | "*" | "+")
                    || bare
                        .trim_end_matches(['.', ')'])
                        .bytes()
                        .all(|b| b.is_ascii_digit()));
            return if marker_only {
                "Differences row 9 — `-` or `1.` with nothing after is plain".into()
            } else if old.lists > 1 && indent == 0 {
                "Lists — a list item needs its own marker; a lazy line in a nested item is plain"
                    .into()
            } else {
                "UNPREDICTED — list item → plain".into()
            };
        }
        (Shape::Plain, Shape::List(_)) => {
            return if old.continuation {
                "A line is read by its own text — a list marker under text is a list item".into()
            } else if old.lists > 0 {
                "A line is read by its own text — a list marker CommonMark keeps as item text"
                    .into()
            } else {
                "UNPREDICTED — plain → list item".into()
            };
        }
        (Shape::Plain, Shape::Heading(_)) => {
            return if old.continuation || old.lists > 0 {
                "A line is read by its own text — a heading line under text or a bullet".into()
            } else {
                "UNPREDICTED — plain → heading".into()
            };
        }
        (Shape::Plain, Shape::Divider) => {
            return if old.continuation || old.lists > 0 || old.quote > 0 {
                "A line is read by its own text — a divider line under text or in an item".into()
            } else {
                "UNPREDICTED — plain → divider".into()
            };
        }
        (Shape::List(a), Shape::List(b)) if a != b => {
            return "Lists — depth comes from the indent of the list lines above".into();
        }
        (Shape::Plain, Shape::Blank) | (Shape::Blank, Shape::Plain) => {
            return format!(
                "UNPREDICTED — {} → {}",
                kind_name(&before),
                kind_name(&after)
            );
        }
        _ => {}
    }
    if before != after {
        return format!(
            "UNPREDICTED — {} → {}",
            kind_name(&before),
            kind_name(&after)
        );
    }
    if let (
        Some(number),
        Kind::List {
            text: marker,
            ordered: true,
            ..
        },
    ) = (old.number, &line.kind)
    {
        let typed: Option<u64> = source[marker.clone()]
            .trim_end_matches(['.', ')'])
            .parse()
            .ok();
        if typed != Some(number) {
            return "Differences row 8 — numbers show as typed, not counted".into();
        }
    }
    String::new()
}

pub(super) fn delimiter_like(row: &str) -> bool {
    row.starts_with('|')
        && row
            .bytes()
            .all(|b| matches!(b, b'|' | b'-' | b':' | b' ' | b'\t'))
}

/// Why the fence state first diverged at a fence line.
pub(super) fn fence_edge_class(old: &Old, text: &str, line: &Line, fallback: &str) -> String {
    let trimmed = text.trim_start_matches([' ', '\t']);
    let indent = text.len() - trimmed.len();
    match line.kind {
        Kind::Fence {
            role: FenceRole::Open,
            ..
        } if !old.fenced => {
            let info = trimmed.trim_start_matches(['`', '~']);
            if trimmed.starts_with('`') && info.contains('`') {
                "Code — ASK: a backtick fence whose info text holds a backtick opens a fence".into()
            } else if old.indented_code {
                "Code — a fence the indented code block hid now opens".into()
            } else {
                fallback.into()
            }
        }
        Kind::Fence {
            role: FenceRole::Open,
            ..
        } if old.fence_edge && !old.fence_open => {
            "Code — a closing fence CommonMark matched to an opener Linedown does not see (after a list marker, after `>`, or in indented code) opens a new fence".into()
        }
        Kind::Fence {
            role: FenceRole::Close,
            ..
        } if old.fenced && !old.fence_edge && indent >= 4 => {
            "Code — a closing fence may be indented (CommonMark allows at most 3 spaces)".into()
        }
        _ if fallback.is_empty() => {
            "Code — a fence runs to its closing line or the note's end, not its container's end"
                .into()
        }
        _ => fallback.into(),
    }
}

pub(super) fn new_span_kind(span: &Span, source: &str) -> Option<OldSpan> {
    Some(match span.kind {
        SpanKind::Bold => OldSpan::Bold,
        SpanKind::Italic => OldSpan::Italic,
        SpanKind::Strike => OldSpan::Strike,
        SpanKind::Code => OldSpan::Code,
        SpanKind::Link { .. } => OldSpan::Link,
        SpanKind::Image { .. } => OldSpan::Image,
        SpanKind::Url { .. } if source[span.range.clone()].starts_with('<') => OldSpan::Angle,
        _ => return None,
    })
}

/// The class of a line whose blocks agree but whose inline marks differ.
pub(super) fn inline_class(
    source: &str,
    line: &Line,
    old: &[(OldSpan, usize, usize)],
    new: &[(OldSpan, usize, usize)],
    crossing: bool,
    hidden: &[(SpanKind, Range<usize>)],
) -> String {
    let only_old: Vec<_> = old.iter().filter(|s| !new.contains(s)).collect();
    let only_new: Vec<_> = new.iter().filter(|s| !old.contains(s)).collect();
    if only_old.is_empty() && only_new.is_empty() {
        return String::new();
    }
    if crossing {
        return "Inline — a mark left open does not carry to the next line (pairing on this line changed)".into();
    }
    let inside = |kinds: &[fn(&SpanKind) -> bool]| {
        only_old.iter().any(|s| {
            hidden.iter().any(|(kind, range)| {
                kinds.iter().any(|k| k(kind)) && range.start < s.2 && s.1 < range.end
            })
        })
    };
    if inside(&[|k| matches!(k, SpanKind::Wikilink { .. })]) {
        return "Wikilinks — a wikilink's text is its target, not markdown (`[[a_b_]]`, `[[1]](url)`)".into();
    }
    if inside(&[|k| matches!(k, SpanKind::Url { .. })]) {
        return "Inline — a bare URL's punctuation belongs to the URL".into();
    }
    let text = |s: &&(OldSpan, usize, usize)| &source[s.1..s.2];
    if only_old.iter().any(|s| s.0 == OldSpan::Reference) {
        return "Not in version 1 — reference links and images are literal".into();
    }
    if only_old
        .iter()
        .any(|s| s.0 == OldSpan::Strike && !text(s).starts_with("~~"))
    {
        return "Inline — strikethrough is `~~`; a single `~` is literal".into();
    }
    if line.quote > 0 || matches!(line.kind, Kind::List { .. }) {
        let content = &source[line.content.clone()];
        if content.starts_with([' ', '\t']) {
            return "Lists — text after the marker's one space shows as typed".into();
        }
    }
    if only_old
        .iter()
        .chain(&only_new)
        .any(|s| text(s).contains('&'))
    {
        return "Not in version 1 — entities are literal text".into();
    }
    if only_old.iter().any(|s| s.0 == OldSpan::Angle) {
        return "Not in version 1 — raw HTML: `<…>` that is not a URL is literal".into();
    }
    if matches!(line.kind, Kind::Table { .. }) {
        return "UNPREDICTED — inline marks in a table cell".into();
    }
    format!(
        "UNPREDICTED — inline: before {:?} now {:?}",
        only_old.iter().map(|s| (s.0, text(s))).collect::<Vec<_>>(),
        only_new.iter().map(|s| (s.0, text(s))).collect::<Vec<_>>()
    )
}
