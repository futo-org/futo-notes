//! A top-level paragraph's sealed soft-line seams: no inline element or
//! literal delimiter able to pair crosses them.
use super::word::next_word_seam;
use super::{Cut, CHUNK, SPLIT_MIN};
use pulldown_cmark::Event;

/// The line ending at `at` ends with LF and no hard-break spelling.
pub(super) fn seam_after(source: &str, at: usize) -> bool {
    let Some(line) = source[..at].strip_suffix('\n') else {
        return false;
    };
    let line = line.strip_suffix('\r').unwrap_or(line);
    !line.ends_with([' ', '\t', '\\'])
}

/// The line at `at` continues a paragraph and cannot start a block alone.
pub(super) fn seam_before(source: &str, at: usize) -> bool {
    let rest = &source[at..];
    let text = rest.trim_start_matches(' ');
    if rest.len() - text.len() > 3 {
        return false;
    }
    let Some(first) = text.chars().next() else {
        return false;
    };
    // A table line leads with `|`, which starts no block without the
    // table extension: the line reads the same continued or alone.
    if !first.is_alphanumeric() && first != '|' {
        return false;
    }
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    !(digits > 0 && matches!(text.as_bytes().get(digits), Some(b'.' | b')')))
}

pub(super) struct Paragraph {
    pub(super) range: std::ops::Range<usize>,
    /// Ranges no seam may enter: inline elements and literal bracket pairs.
    pub(super) covered: Vec<std::ops::Range<usize>>,
    /// Open literal brackets.
    pub(super) depth: Vec<usize>,
    pub(super) dangling: bool,
    /// A literal `*`, `_` or `~` run able to pair with another row's run.
    pub(super) emphasis: bool,
    /// A wikilink bracket pair that a word seam could separate: wikilinks
    /// read to the next `]]` on their line, outside CommonMark.
    pub(super) word_dangling: bool,
}

impl Paragraph {
    pub(super) fn new(range: std::ops::Range<usize>) -> Self {
        Self {
            range,
            covered: Vec::new(),
            depth: Vec::new(),
            dangling: false,
            emphasis: false,
            word_dangling: false,
        }
    }

    /// Wikilinks bound word seams like inline elements; an unmatched `[[`
    /// or `]]` may pair across a word seam, so it allows none.
    pub(super) fn wikilinks(&mut self, source: &str) {
        let text = &source[self.range.clone()];
        if !text.contains("[[") && !text.contains("]]") {
            return;
        }
        let links = futo_notes_wikilinks::find_wikilinks(text);
        let base = self.range.start;
        // Links come sorted and disjoint, and delimiters are visited in
        // order, so one forward sweep answers every lookup.
        let mut next = links.iter().peekable();
        let mut inside = |at: usize| {
            while next.next_if(|link| link.end <= at).is_some() {}
            next.peek().is_some_and(|link| link.start <= at)
        };
        self.word_dangling = text
            .as_bytes()
            .windows(2)
            .enumerate()
            .any(|(at, pair)| (pair == b"[[" || pair == b"]]") && !inside(at));
        self.covered
            .extend(links.iter().map(|link| base + link.start..base + link.end));
    }

    pub(super) fn inline(
        &mut self,
        source: &str,
        event: &Event<'_>,
        range: std::ops::Range<usize>,
    ) {
        match event {
            Event::Text(_) => self.scan(source, range),
            Event::InlineHtml(_) | Event::Html(_) => {
                let raw = &source[range.clone()];
                self.dangling |= !(raw.starts_with('<') && raw.ends_with('>'));
                self.covered.push(range);
            }
            Event::Start(_) | Event::Code(_) | Event::InlineMath(_) | Event::DisplayMath(_) => {
                self.covered.push(range)
            }
            Event::FootnoteReference(_) => self.dangling = true,
            _ => {}
        }
    }

    /// Literal characters that could pair with syntax in another row.
    fn scan(&mut self, source: &str, range: std::ops::Range<usize>) {
        let bytes = source.as_bytes();
        for at in range {
            let byte = bytes[at];
            if !matches!(byte, b'*' | b'_' | b'~' | b'`' | b'[' | b']' | b'<') {
                continue;
            }
            let escapes = bytes[..at]
                .iter()
                .rev()
                .take_while(|&&b| b == b'\\')
                .count();
            if escapes % 2 == 1 {
                continue;
            }
            let before = source[..at].chars().next_back();
            let after = source[at + 1..].chars().next();
            let space = |c: Option<char>| c.is_none_or(char::is_whitespace);
            self.dangling |= match byte {
                b'`' => true,
                b'[' => {
                    self.depth.push(at);
                    false
                }
                b']' => match self.depth.pop() {
                    Some(open) => {
                        self.covered.push(open..at + 1);
                        false
                    }
                    None => true,
                },
                b'<' => after.is_none_or(|c| c.is_ascii_alphabetic() || "/!?".contains(c)),
                b'_' => {
                    let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
                    self.emphasis |=
                        !(space(before) && space(after) || word(before) && word(after));
                    false
                }
                _ => {
                    self.emphasis |= !(space(before) && space(after));
                    false
                }
            };
        }
    }

    /// `long`: whether the first and last lines continue past the text at
    /// word seams, so they are long whatever their length here.
    pub(super) fn cuts(mut self, source: &str, long: (bool, bool), cuts: &mut Vec<(usize, Cut)>) {
        self.covered.sort_by_key(|range| range.start);
        let mut covered = self.covered.iter().peekable();
        let mut reach = 0;
        let mut last = self.range.start;
        let end = self.range.end;
        let mut line_start = self.range.start;
        loop {
            let line_end = source[line_start..end]
                .find('\n')
                .map_or(end, |at| line_start + at);
            // Word seams cut only a line too long for line seams alone to
            // bound a row; a line holding a `|` may be a table row and stays whole.
            let line = &source[line_start..line_end];
            let long = line.len() >= SPLIT_MIN
                || long.0 && line_start == self.range.start
                || long.1 && line_end == end;
            let mut from = if self.word_dangling || !long || line.contains('|') {
                line_end
            } else {
                last + CHUNK
            };
            while from < line_end {
                let Some(at) = next_word_seam(source, line_start..line_end, from) else {
                    break;
                };
                while let Some(range) = covered.next_if(|range| range.start < at) {
                    reach = reach.max(range.end);
                }
                if reach <= at {
                    cuts.push((at, Cut::Continue));
                    last = at;
                    from = at + CHUNK;
                } else {
                    from = reach;
                }
            }
            let at = line_end + 1;
            if at >= end {
                break;
            }
            while let Some(range) = covered.next_if(|range| range.start < at) {
                reach = reach.max(range.end);
            }
            if reach <= at
                && at - last >= CHUNK
                && seam_after(source, at)
                && seam_before(source, at)
            {
                cuts.push((at, Cut::Continue));
                last = at;
            }
            line_start = at;
        }
    }
}
