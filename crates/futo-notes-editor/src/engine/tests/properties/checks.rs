//! Checks an engine against a fresh read: properties 4 and 5.
use super::*;

/// Property 4, and the index: every line, its reading and its display equal
/// a fresh read of the same text, and the reader's own whole-note reading.
pub(in crate::engine::tests) fn check_fresh(engine: &Engine, context: &str) {
    let source = engine.source_text();
    let fresh = read::open(&source);
    assert_eq!(engine.store.len(), fresh.len(), "{context}");
    for (index, (have, want)) in engine
        .store
        .iter_from(0)
        .zip(fresh.iter_from(0))
        .enumerate()
    {
        assert_eq!(have.text, want.text, "line {index} {context}");
        assert_eq!(have.carry, want.carry, "line {index} carry {context}");
        assert_eq!(have.line, want.line, "line {index} reading {context}");
        assert_eq!(have.spans, want.spans, "line {index} spans {context}");
        assert_eq!(have.links, want.links, "line {index} link bits {context}");
        assert_eq!(have.view, want.view, "line {index} display {context}");
        assert_eq!(have.size, want.size, "line {index} size {context}");
    }
    assert_eq!(engine.store.total(), fresh.total(), "{context}");
    engine.store.check_links(context);
    let mut sum = crate::engine::store::Size::default();
    for index in 0..engine.store.len() {
        assert_eq!(
            engine.store.before(index),
            sum,
            "index before line {index} {context}"
        );
        let size = engine.store.get(index).size;
        sum = crate::engine::store::Size {
            lines: sum.lines + size.lines,
            source: sum.source + size.source,
            display: sum.display + size.display,
            source16: sum.source16 + size.source16,
            display16: sum.display16 + size.display16,
        };
    }
    // The reader's whole-note reading, line-relative.
    let reading = Reading::new(&source);
    assert_eq!(reading.lines.len(), engine.store.len(), "{context}");
    let mut base = 0;
    for (index, entry) in engine.store.iter_from(0).enumerate() {
        let line = &reading.lines[index];
        let local = |range: &std::ops::Range<usize>| range.start - base..range.end - base;
        assert_eq!(
            local(&line.range),
            entry.line.range,
            "line {index} {context}"
        );
        assert_eq!(line.ending, entry.line.ending, "line {index} {context}");
        assert_eq!(line.quote, entry.line.quote, "line {index} {context}");
        assert_eq!(
            local(&line.marker),
            entry.line.marker,
            "line {index} {context}"
        );
        assert_eq!(
            local(&line.content),
            entry.line.content,
            "line {index} {context}"
        );
        assert_eq!(
            std::mem::discriminant(&line.kind),
            std::mem::discriminant(&entry.line.kind),
            "line {index} {context}"
        );
        assert_eq!(
            reading.carries[index], entry.carry,
            "line {index} {context}"
        );
        let spans: Vec<_> = reading.spans[index]
            .iter()
            .map(|span| (local(&span.range), local(&span.open), local(&span.close)))
            .collect();
        let have: Vec<_> = entry
            .spans
            .iter()
            .map(|span| (span.range.clone(), span.open.clone(), span.close.clone()))
            .collect();
        assert_eq!(spans, have, "line {index} spans {context}");
        base += entry.text.len();
    }
    assert_eq!(engine.display_text(), fresh_display(&source), "{context}");
}

/// Each line's reading and how it shows, for comparing before and after.
pub(super) type Shape = (
    crate::lines::Line,
    Vec<crate::lines::Span>,
    crate::engine::line::View,
);

pub(super) fn lines_of(engine: &Engine) -> Vec<Shape> {
    engine
        .store
        .iter_from(0)
        .map(|entry| (entry.line.clone(), entry.spans.clone(), entry.view.clone()))
        .collect()
}

/// A renderer restyles only each change's lines: every line that shows
/// outside them reads and shows as it did before. Checked for steps that
/// made one change.
pub(super) fn check_restyled(before: &[Shape], engine: &Engine, view: &mut View, context: &str) {
    let restyled = std::mem::take(&mut view.restyled);
    let [lines] = restyled.as_slice() else {
        return;
    };
    let after = lines_of(engine);
    let mut display = 0;
    for (index, entry) in engine.store.iter_from(0).enumerate() {
        let (start, end) = (display, display + entry.size.display);
        display = end;
        let empty = entry.size.display == 0 && entry.view.role != Role::Empty;
        if empty {
            continue;
        }
        let old = if end <= lines.start && start < lines.start {
            before.get(index)
        } else if start >= lines.end && end > lines.end {
            (before.len() + index)
                .checked_sub(after.len())
                .and_then(|i| before.get(i))
        } else {
            continue;
        };
        assert_eq!(
            old,
            Some(&after[index]),
            "line {index} outside the restyled {lines:?} changed: {context}"
        );
    }
}

pub(super) fn fresh_display(source: &str) -> String {
    Engine::open(source).display_text()
}

/// Source offsets a caret can stand at, from the reader's own reading:
/// not inside a frame line, a line's leading marker, an escape (between the
/// backslash and its character), a run of hidden syntax, a divider or a CRLF.
pub(super) fn caret_positions(source: &str) -> Vec<usize> {
    let reading = Reading::new(source);
    let mut out = Vec::new();
    for (index, line) in reading.lines.iter().enumerate() {
        match &line.kind {
            Kind::Fence {
                role: FenceRole::Open | FenceRole::Close,
                ..
            }
            | Kind::FrontMatter(
                crate::lines::FrontMatterRole::Open | crate::lines::FrontMatterRole::Close,
            ) => continue,
            Kind::Divider => {
                out.extend([line.range.start, line.range.end]);
                continue;
            }
            _ => {}
        }
        let shows_marker = matches!(
            line.kind,
            Kind::FrontMatter(_)
                | Kind::Table {
                    role: TableRole::Delimiter,
                    ..
                }
        );
        let mut hidden: Vec<std::ops::Range<usize>> = Vec::new();
        let mut after_escape = Vec::new();
        if !shows_marker && !line.marker.is_empty() {
            hidden.push(line.marker.start..line.marker.end);
        }
        for span in &reading.spans[index] {
            for piece in [&span.open, &span.close] {
                if !piece.is_empty() {
                    hidden.push(piece.clone());
                }
            }
            if span.kind == SpanKind::Escape {
                after_escape.push(span.open.end);
            }
        }
        hidden.sort_by_key(|range| range.start);
        let mut runs: Vec<std::ops::Range<usize>> = Vec::new();
        for range in hidden {
            match runs.last_mut() {
                Some(last) if last.end >= range.start => last.end = last.end.max(range.end),
                _ => runs.push(range),
            }
        }
        let marker_end = (!shows_marker).then_some(line.marker.end);
        for at in line.range.start..=line.range.end {
            if !source.is_char_boundary(at)
                || runs.iter().any(|run| run.start < at && at < run.end)
                || marker_end.is_some_and(|end| at < end)
                || after_escape.contains(&at)
            {
                continue;
            }
            out.push(at);
        }
    }
    out
}

/// Property 5, and the UTF-16 half of it.
pub(super) fn check_positions(engine: &Engine, context: &str) {
    let source = engine.source_text();
    let display = engine.display_text();
    for at in caret_positions(&source) {
        let shown = engine.display_of(at);
        let (lo, hi) = engine.source_bounds(shown);
        assert!(
            at == lo || at == hi,
            "source {at} shows at {shown}, which maps back to {lo}..{hi} {context}"
        );
    }
    for at in 0..=display.len() {
        if !display.is_char_boundary(at) {
            assert_eq!(
                engine.check_display(at).err(),
                Some(EditorError::InvalidRange)
            );
            continue;
        }
        let (lo, hi) = engine.source_bounds(at);
        assert!(lo <= hi, "{context}");
        assert_eq!(engine.display_of(lo), at, "display {at} low end {context}");
        assert_eq!(engine.display_of(hi), at, "display {at} high end {context}");
        let units = engine.display16(at).unwrap();
        assert_eq!(units, display[..at].encode_utf16().count(), "{context}");
        assert_eq!(engine.display_from16(units), Ok(at), "{context}");
    }
    let check16 = |text: &str, from: &dyn Fn(usize) -> Result<usize, EditorError>| {
        let units: Vec<u16> = text.encode_utf16().collect();
        for at in 0..=units.len() + 1 {
            let splits = at > 0 && at < units.len() && (0xDC00..0xE000).contains(&units[at]);
            let want = if at > units.len() || splits {
                Err(EditorError::InvalidRange)
            } else {
                Ok(String::from_utf16(&units[..at]).unwrap().len())
            };
            assert_eq!(from(at), want, "UTF-16 offset {at} {context}");
        }
    };
    check16(&display, &|at| engine.display_from16(at));
    check16(&source, &|at| engine.source_from16(at));
    for at in 0..=source.len() {
        let got = engine.source16(at);
        if source.is_char_boundary(at) {
            assert_eq!(got, Ok(source[..at].encode_utf16().count()), "{context}");
        } else {
            assert_eq!(got, Err(EditorError::InvalidRange), "{context}");
        }
    }
}
