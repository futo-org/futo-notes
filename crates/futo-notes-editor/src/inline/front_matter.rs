//! YAML front matter: a document-start metadata block the engine never
//! interprets. The rule is the shipping one (`packages/editor/src/
//! milkdown-compat/frontmatter.ts`): an optional BOM, a first line of `---`
//! plus spaces/tabs ended by CR, LF or CRLF, and a later column-zero `---`
//! line (spaces/tabs allowed) ended by a line break or EOF. Without that
//! closer there is no front matter, and everything stays ordinary Markdown.
use crate::SourceEdit;
use ropey::Rope;
use std::iter::Peekable;

/// Source length of the leading front matter, closer line ending included,
/// or zero. Reads only until the first closer.
pub(crate) fn len(bytes: impl Iterator<Item = u8>) -> usize {
    let mut lines = Lines {
        bytes: bytes.peekable(),
        at: 0,
    };
    if !lines.opener() {
        return 0;
    }
    while let Some((fence, _)) = lines.line() {
        if fence {
            return lines.at;
        }
    }
    0
}

/// End of an opening fence line, if the source starts with one. Reads only
/// that line.
pub(crate) fn opener_end(bytes: impl Iterator<Item = u8>) -> Option<usize> {
    let mut lines = Lines {
        bytes: bytes.peekable(),
        at: 0,
    };
    lines.opener().then_some(lines.at)
}

/// Whether one complete line (ending excluded) is a fence.
pub(crate) fn is_fence(line: &str) -> bool {
    line.strip_prefix("---")
        .is_some_and(|rest| rest.bytes().all(|b| matches!(b, b' ' | b'\t')))
}

struct Lines<I: Iterator<Item = u8>> {
    bytes: Peekable<I>,
    at: usize,
}

impl<I: Iterator<Item = u8>> Lines<I> {
    fn opener(&mut self) -> bool {
        if self.bytes.peek() == Some(&0xEF) {
            for expected in [0xEF, 0xBB, 0xBF] {
                if self.take() != Some(expected) {
                    return false;
                }
            }
        }
        // A byte that cannot continue a fence ends the read: a long first
        // line is not scanned on every edit.
        self.line_until(true) == Some((true, true))
    }

    fn take(&mut self) -> Option<u8> {
        let byte = self.bytes.next();
        self.at += usize::from(byte.is_some());
        byte
    }

    /// (is a fence, ended by a line break); None at EOF.
    fn line(&mut self) -> Option<(bool, bool)> {
        self.line_until(false)
    }

    /// `line`, stopping at the first byte that rules a fence out when
    /// `fence_only` (the rest of the line then stays unread).
    fn line_until(&mut self, fence_only: bool) -> Option<(bool, bool)> {
        self.bytes.peek()?;
        let mut dashes = Some(0u8);
        loop {
            match self.take() {
                None => return Some((dashes == Some(3), false)),
                Some(b'\n') => return Some((dashes == Some(3), true)),
                Some(b'\r') => {
                    if self.bytes.peek() == Some(&b'\n') {
                        self.take();
                    }
                    return Some((dashes == Some(3), true));
                }
                Some(b'-') => dashes = dashes.filter(|count| *count < 3).map(|count| count + 1),
                Some(b' ' | b'\t') => dashes = dashes.filter(|count| *count == 3),
                Some(_) => dashes = None,
            }
            if fence_only && dashes.is_none() {
                return Some((false, false));
            }
        }
    }
}

impl super::row::Row {
    /// Inert metadata: fence lines are hidden, the body shows verbatim with
    /// no inline or block meaning, and one block description covers it.
    pub(crate) fn metadata(source: &str) -> Self {
        use super::blocks::{BlockLine, PhysicalLine};
        use super::row::Segment;
        let opener = source.find(['\r', '\n']).map_or(source.len(), |at| {
            at + if source[at..].starts_with("\r\n") {
                2
            } else {
                1
            }
        });
        let unterminated = source.trim_end_matches(['\r', '\n']);
        let closer = unterminated
            .rfind(['\r', '\n'])
            .map_or(opener, |at| at + 1)
            .max(opener);
        let value = &source[opener..closer];
        // One terminal line ending separates the panel from the body.
        let ending = if value.ends_with("\r\n") {
            2
        } else {
            usize::from(value.ends_with(['\r', '\n']))
        };
        let content_end = closer - ending;
        let segments = [
            (0..opener, false),
            (opener..closer, true),
            (closer..source.len(), false),
        ]
        .into_iter()
        .filter(|(range, _)| !range.is_empty())
        .map(|(range, shown)| Segment {
            display: if shown {
                0..value.len()
            } else if range.start == 0 {
                0..0
            } else {
                value.len()..value.len()
            },
            source: range,
            identity: shown,
        })
        .collect();
        let line = PhysicalLine {
            source: 0..source.len(),
            content: opener..content_end,
        };
        Self {
            continues: false,
            mid_line: false,
            through: false,
            source_len: source.len(),
            pipes: source.contains('|'),
            table_scan: crate::table::RowScan::new(source),
            parsed_source_bytes: source.len() * 2,
            guarded_words: Vec::new(),
            typed_inputs: Vec::new(),
            literal_delimiters: Vec::new(),
            literal_links: Vec::new(),
            definitions: Vec::new(),
            reference_uses: Vec::new(),
            reference_work: Default::default(),
            // Front matter is inert metadata: no wikilink or image roles.
            wikilinks: Vec::new(),
            wikilink_mask: 0,
            wikilink_isolated: Vec::new(),
            images: Vec::new(),
            display: value.to_owned(),
            segments,
            spans: Vec::new(),
            blocks: vec![BlockLine {
                source: line.source.clone(),
                content: line.content.clone(),
                metadata: true,
                bodies: vec![line],
                ..BlockLine::default()
            }],
            metadata: true,
            opener: None,
            context: None,
            context_ends: Vec::new(),
            tail_chain: Vec::new(),
        }
    }
}

impl super::Projection {
    /// Source length of the leading front matter row, or zero.
    pub(crate) fn metadata_len(&self) -> usize {
        let (row, _, _) = self.rows.at(0);
        if row.metadata {
            row.source_len
        } else {
            0
        }
    }

    /// Endpoints inside front matter move to the body start; a selection
    /// starting at the note's start may still cover all of the metadata.
    pub(crate) fn outside_metadata(&self, mut range: crate::DisplayRange) -> crate::DisplayRange {
        let body = crate::DisplayOffset(self.body_start());
        if range.end.0 < body.0 {
            range.end = body;
        }
        if range.start.0 < body.0 && (range.start.0 > 0 || range.end == body) {
            range.start = body;
        }
        range
    }

    /// Display offset where the body (first legal caret) starts.
    pub(crate) fn body_start(&self) -> usize {
        let (row, _, _) = self.rows.at(0);
        if row.metadata {
            row.display.len()
        } else {
            0
        }
    }

    /// Front matter length after `edit` (already applied to `source`), plus
    /// bytes scanned. Only an edit at the opener, inside the metadata, or on a
    /// line that can now close an opened block rescans.
    pub(super) fn metadata_after(
        &self,
        source: &Rope,
        edit: &SourceEdit,
        old: usize,
    ) -> (usize, usize) {
        if !self.document_start {
            return (0, 0);
        }
        let start = edit.range.start.0;
        if old > 0 {
            let settled = start > old || (start == old && source.byte(old - 1) == b'\n');
            if settled {
                return (old, 0);
            }
            return self.rescan_metadata(source);
        }
        // Reading stops at the first byte that cannot continue an opener.
        let Some(opener_end) = opener_end(source.bytes()) else {
            return (0, 0);
        };
        let end = start + edit.inserted.len();
        let closes = start <= opener_end
            || (source.byte_to_line(start)..=source.byte_to_line(end)).any(|line| {
                let line = source.line(line);
                let text: String = line.chars().take(64).collect();
                is_fence(text.trim_end_matches(['\r', '\n']))
            });
        if !closes {
            return (0, opener_end);
        }
        self.rescan_metadata(source)
    }

    fn rescan_metadata(&self, source: &Rope) -> (usize, usize) {
        // An unclosed opener reads to EOF before it is refused.
        let length = len(source.bytes());
        (
            length,
            if length > 0 {
                length
            } else {
                source.len_bytes()
            },
        )
    }
}
