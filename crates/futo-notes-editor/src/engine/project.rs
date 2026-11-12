//! What a view draws: each line's reading described in display offsets.
//! Every description comes from one line's reading; nothing looks across
//! lines except the fence language a code line carries.
use super::line::{Cut, Entry, Role, DIVIDER};
use super::Engine;
use crate::lines::{FenceRole, FrontMatterRole, Kind, SpanKind};
use crate::{
    AtomDescription, AtomKind, BlockDescription, Correspondence, CorrespondenceKind, DisplayOffset,
    DisplayRange, ImageDescription, InlineFormat, LinkDescription, ListDescription,
    ProjectionSlice, SemanticRun, SourceOffset, SourceRange, WikilinkDescription,
};
use futo_notes_wikilinks::WikilinkIndex;

fn display_range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

/// The inline format a span gives the text inside its marks.
fn format_of(kind: &SpanKind) -> Option<InlineFormat> {
    match kind {
        SpanKind::Bold => Some(InlineFormat::Bold),
        SpanKind::Italic => Some(InlineFormat::Italic),
        SpanKind::Strike => Some(InlineFormat::Strike),
        SpanKind::Code => Some(InlineFormat::Code),
        _ => None,
    }
}

impl Engine {
    /// Everything a view needs to draw display `range` (checked by the
    /// caller): the lines it touches, whole, and an empty line at its end.
    pub(crate) fn projection(
        &self,
        revision: crate::Revision,
        range: DisplayRange,
    ) -> ProjectionSlice {
        let (a, b) = (range.start.0, range.end.0);
        let mut slice = ProjectionSlice {
            revision,
            range,
            text: self.display_slice(a..b),
            runs: Vec::new(),
            correspondence: Vec::new(),
            blocks: Vec::new(),
            links: Vec::new(),
            wikilinks: Vec::new(),
            atoms: Vec::new(),
        };
        let (first, before) = self.line_at_display(super::store::display, a);
        let first = (0..first)
            .rev()
            .take_while(|&index| self.store.get(index).size.display == 0)
            .last()
            .unwrap_or(first);
        let mut source = self.store.before(first).source;
        let mut display = if first == 0 {
            0
        } else {
            self.store.before(first).display
        };
        debug_assert!(display <= before.display);
        for entry in self.store.iter_from(first) {
            if display > b {
                break;
            }
            let end = display + entry.size.display;
            let touches = (display < b && end > a)
                || (entry.shown_len() == 0 && display >= a && display <= b)
                || (a == b && display <= a && a < end);
            if touches {
                describe(entry, source, display, &self.notes, &mut slice);
            }
            source += entry.size.source;
            display = end;
        }
        slice
    }

    /// The formats typing at the caret carries.
    pub fn active_formats(&self) -> Vec<InlineFormat> {
        if let Some(formats) = &self.formats {
            return formats.clone();
        }
        let at = self.caret_source();
        let (index, before) = super::read::line_at(&self.store, at);
        let local = at - before.source;
        let mut formats: Vec<InlineFormat> = self
            .store
            .get(index)
            .spans
            .iter()
            .filter(|span| span.open.end <= local && local <= span.close.start)
            .filter_map(|span| format_of(&span.kind))
            .collect();
        formats.sort();
        formats.dedup();
        formats
    }

    /// The line the caret is on.
    pub(crate) fn caret_line(&self) -> &Entry {
        let (index, _) = super::read::line_at(&self.store, self.caret_source());
        self.store.get(index)
    }

    pub(crate) fn can_undo(&self) -> bool {
        !self.history.undo.is_empty()
    }

    pub(crate) fn can_redo(&self) -> bool {
        !self.history.redo.is_empty()
    }
}

/// Add line `entry`'s descriptions, the line starting at `source` and
/// `display`, to `slice`; its wikilinks resolve against `notes`.
fn describe(
    entry: &Entry,
    source: usize,
    display: usize,
    notes: &WikilinkIndex,
    slice: &mut ProjectionSlice,
) {
    let view = &entry.view;
    let shown = entry.shown_len();
    let block = block_of(entry, display, shown);
    if view.role != Role::Text {
        let hidden = SourceRange {
            start: SourceOffset(source),
            end: SourceOffset(source + entry.text.len()),
        };
        if hidden.start != hidden.end {
            slice.correspondence.push(Correspondence {
                source: hidden,
                display: display_range(display, display),
                kind: CorrespondenceKind::Hidden,
            });
        }
        if view.role == Role::Empty {
            slice.blocks.push(block);
        }
        return;
    }
    slice.blocks.push(block);
    correspond(entry, source, display, slice);
    let to_display = |local: usize| display + entry.to_display(local);
    runs(entry, &to_display, slice);

    for span in &entry.spans {
        let text = |range: &std::ops::Range<usize>| entry.text[range.clone()].to_owned();
        match &span.kind {
            SpanKind::Link { destination, title } => slice.links.push(LinkDescription {
                range: display_range(to_display(span.open.end), to_display(span.close.start)),
                destination: destination.clone(),
                title: title.clone(),
            }),
            SpanKind::Url { destination } => slice.links.push(LinkDescription {
                range: display_range(to_display(span.open.end), to_display(span.close.start)),
                destination: destination.clone(),
                title: None,
            }),
            SpanKind::Wikilink { target } => {
                let (label, note_id) = resolve(target, notes);
                slice.wikilinks.push(WikilinkDescription {
                    range: display_range(to_display(span.range.start), to_display(span.range.end)),
                    target: target.clone(),
                    label,
                    note_id,
                });
            }
            SpanKind::Image {
                alt,
                destination,
                title,
            } => {
                let (start, end) = (to_display(span.range.start), to_display(span.range.end));
                slice.atoms.push(AtomDescription {
                    kind: AtomKind::Image,
                    range: display_range(start, end),
                    before: DisplayOffset(start),
                    after: DisplayOffset(end),
                    image: Some(ImageDescription {
                        alt: text(alt),
                        destination: destination.clone(),
                        title: title.clone(),
                        reference: None,
                        vault: futo_notes_image::is_vault_image_reference(destination),
                    }),
                });
            }
            _ => {}
        }
    }
}

/// A wikilink target's label and note id: a target naming one note shows
/// that note's shortest unique suffix; any other shows as written.
pub(crate) fn resolve(target: &str, notes: &WikilinkIndex) -> (String, Option<String>) {
    match notes.resolve(target) {
        Some(id) => (notes.display_suffix(id), Some(id.to_owned())),
        None => (target.to_owned(), None),
    }
}

/// The block facts of line `entry`, shown at `display` for `shown` bytes.
fn block_of(entry: &Entry, display: usize, shown: usize) -> BlockDescription {
    let line = &entry.line;
    let mut block = BlockDescription {
        range: display_range(display, display + shown),
        heading: 0,
        quote_depth: line.quote,
        divider: false,
        list: None,
        code: false,
        language: None,
        metadata: false,
    };
    match &line.kind {
        Kind::Heading { level } => block.heading = *level,
        Kind::Divider => block.divider = true,
        Kind::List {
            indent,
            text,
            ordered,
            task,
        } => {
            block.list = Some(ListDescription {
                indent: *indent,
                marker: entry.text[text.clone()].to_owned(),
                ordered: *ordered,
                checked: *task,
                first: true,
            });
        }
        Kind::Plain { indent } if *indent > 0 => {
            block.list = Some(ListDescription {
                indent: *indent,
                marker: String::new(),
                ordered: false,
                checked: None,
                first: true,
            });
        }
        Kind::Fence { role, .. } => {
            // An opening fence shows only as an empty code block's line.
            block.code = *role == FenceRole::Code || entry.view.role == Role::Empty;
            block.language = entry
                .carry
                .fence
                .as_ref()
                .and_then(|fence| fence.language.clone())
                .or_else(|| match &line.kind {
                    Kind::Fence {
                        language: Some(language),
                        ..
                    } => Some(entry.text[language.clone()].to_owned()),
                    _ => None,
                });
        }
        Kind::FrontMatter(FrontMatterRole::Body) => block.metadata = true,
        Kind::FrontMatter(_) => block.metadata = entry.view.role == Role::Empty,
        _ => {}
    }
    block
}

/// Line `entry`'s correspondence (a shown line), and its divider atom.
fn correspond(entry: &Entry, source: usize, display: usize, slice: &mut ProjectionSlice) {
    let view = &entry.view;
    let body = entry.body_len();
    let mut at = 0;
    let mut shown_at = display;
    let literal = |slice: &mut ProjectionSlice, from: usize, to: usize, shown_at: usize| {
        if from < to {
            slice.correspondence.push(Correspondence {
                source: SourceRange {
                    start: SourceOffset(source + from),
                    end: SourceOffset(source + to),
                },
                display: display_range(shown_at, shown_at + to - from),
                kind: CorrespondenceKind::Literal,
            });
        }
    };
    for (range, cut) in &view.cuts {
        literal(slice, at, range.start, shown_at);
        shown_at += range.start - at;
        let width = if *cut == Cut::Divider {
            DIVIDER.len()
        } else {
            0
        };
        slice.correspondence.push(Correspondence {
            source: SourceRange {
                start: SourceOffset(source + range.start),
                end: SourceOffset(source + range.end),
            },
            display: display_range(shown_at, shown_at + width),
            kind: if *cut == Cut::Divider {
                CorrespondenceKind::Replaced
            } else {
                CorrespondenceKind::Hidden
            },
        });
        if *cut == Cut::Divider {
            slice.atoms.push(AtomDescription {
                kind: AtomKind::Divider,
                range: display_range(shown_at, shown_at + width),
                before: DisplayOffset(shown_at),
                after: DisplayOffset(shown_at + width),
                image: None,
            });
        }
        shown_at += width;
        at = range.end;
    }
    literal(slice, at, body, shown_at);
    shown_at += body - at;
    if view.ending {
        literal(slice, body, entry.text.len(), shown_at);
    } else if body < entry.text.len() {
        slice.correspondence.push(Correspondence {
            source: SourceRange {
                start: SourceOffset(source + body),
                end: SourceOffset(source + entry.text.len()),
            },
            display: display_range(shown_at, shown_at),
            kind: CorrespondenceKind::Hidden,
        });
    }
}

/// Line `entry`'s inline formats: each visible stretch between format edges is one run.
fn runs(entry: &Entry, to_display: &dyn Fn(usize) -> usize, slice: &mut ProjectionSlice) {
    let formatted: Vec<_> = entry
        .spans
        .iter()
        .filter_map(|span| format_of(&span.kind).map(|f| (span.open.end..span.close.start, f)))
        .collect();
    if !formatted.is_empty() {
        let mut edges: Vec<usize> = formatted
            .iter()
            .flat_map(|(range, _)| [range.start, range.end])
            .collect();
        edges.sort_unstable();
        edges.dedup();
        for pair in edges.windows(2) {
            let (from, to) = (pair[0], pair[1]);
            let mut formats: Vec<InlineFormat> = formatted
                .iter()
                .filter(|(range, _)| range.start <= from && to <= range.end)
                .map(|(_, f)| *f)
                .collect();
            let (start, end) = (to_display(from), to_display(to));
            if formats.is_empty() || start >= end {
                continue;
            }
            formats.sort();
            formats.dedup();
            match slice.runs.last_mut() {
                Some(run) if run.range.end.0 == start && run.formats == formats => {
                    run.range.end = DisplayOffset(end);
                }
                _ => slice.runs.push(SemanticRun {
                    range: display_range(start, end),
                    formats,
                }),
            }
        }
    }
}
