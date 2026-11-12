//! Tag queries and header-tag edits. Tag grammar, normalization, length,
//! deduplication and code isolation are the canonical `futo-notes-tags` rules;
//! this module only turns their answers into one ordinary accepted edit.
use super::*;
use futo_notes_tags::{
    extract_header_tag_block, extract_tags, is_valid_tag_name, normalize_tag_name,
};

/// The leading header tag block, read from its own lines only.
struct Header {
    /// Source byte where the block starts (the note body start).
    start: usize,
    /// Canonical tags (`#name`, first-seen order, deduplicated).
    tags: Vec<String>,
    /// Exact block bytes, including a trailing blank separator line.
    text: String,
}

impl EditorSession {
    /// The first source byte that belongs to the
    /// note body. Header tags and body tags are scanned from here, so front
    /// matter before it is neither a tag source nor touched by tag edits.
    fn tag_body_start(&self) -> usize {
        self.projection.metadata_len()
    }

    /// Canonical tags (`#name`) of the body, in first-seen order. One on-demand
    /// scan; no edit calls it.
    pub fn tags(&self) -> Vec<String> {
        on_next!(ref self, |e| e.tags());
        let from = self.source.byte_to_char(self.tag_body_start());
        extract_tags(&self.source.slice(from..).to_string())
    }

    /// Canonical tags of the leading header tag block.
    pub fn header_tags(&self) -> Vec<String> {
        on_next!(ref self, |e| e.header_tags());
        self.read_header().tags
    }

    fn read_header(&self) -> Header {
        let start = self.tag_body_start();
        let mut chars = self.source.slice(self.source.byte_to_char(start)..).chars();
        let mut text = String::new();
        loop {
            let mut line = String::new();
            for c in chars.by_ref() {
                line.push(c);
                if c == '\n' {
                    break;
                }
            }
            if line.is_empty() {
                break;
            }
            let tag_line = !extract_header_tag_block(&line).tags.is_empty();
            text.push_str(&line);
            if !tag_line {
                break;
            }
        }
        let block = extract_header_tag_block(&text);
        text.truncate(block.end_offset);
        Header {
            start,
            tags: block.tags,
            text,
        }
    }

    /// Add a tag to the header block, creating the block when absent. The tag
    /// is normalized; one already present (case-insensitively) changes nothing.
    pub fn add_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        on_next!(self, accept, |e, accept| e
            .add_header_tag(expected, tag, accept));
        self.check_revision(expected)?;
        let name = normalize_tag_name(tag);
        if !is_valid_tag_name(&name) {
            return Err(EditorError::InvalidText);
        }
        let header = self.read_header();
        if header.tags.contains(&format!("#{name}")) {
            return Ok(None);
        }
        let (at, inserted) = if header.tags.is_empty() {
            let mut breaks = self
                .source
                .slice(self.source.byte_to_char(header.start)..)
                .chars()
                .skip_while(|&c| c != '\n' && c != '\r');
            let eol = match (breaks.next(), breaks.next()) {
                (Some('\r'), Some('\n')) => "\r\n",
                (Some('\r'), _) => "\r",
                _ => "\n",
            };
            let body_empty = self.source.len_bytes() == header.start;
            let tail = if body_empty { "" } else { eol };
            (header.start, format!("#{name}{tail}{tail}"))
        } else {
            let last = header
                .text
                .split_inclusive('\n')
                .scan(0, |at, line| {
                    let start = *at;
                    *at += line.len();
                    Some((start, line))
                })
                .filter(|(_, line)| !line.trim().is_empty())
                .last()
                .unwrap();
            (
                header.start + last.0 + last.1.trim_end().len(),
                format!(" #{name}"),
            )
        };
        self.edit_source(expected, at..at, &inserted, None, accept)
    }

    /// Remove every spelling of a tag from the header block, keeping all other
    /// bytes. A line left without tags goes away; an emptied block also drops
    /// its blank separator.
    pub fn remove_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        on_next!(self, accept, |e, accept| e
            .remove_header_tag(expected, tag, accept));
        self.check_revision(expected)?;
        let name = normalize_tag_name(tag);
        let header = self.read_header();
        if !header.tags.contains(&format!("#{name}")) {
            return Ok(None);
        }
        let mut rewritten = String::new();
        let mut kept_lines = 0;
        let mut tag_bytes = 0;
        for line in header.text.split_inclusive('\n') {
            if line.trim().is_empty() {
                continue; // separator: re-added below only while tags remain
            }
            tag_bytes += line.len();
            let body = line.trim_end_matches(['\n', '\r']);
            let eol = &line[body.len()..];
            // (whitespace before, token) pairs plus the trailing whitespace.
            let mut tokens = Vec::new();
            let mut rest = body;
            while let Some(begin) = rest.find(|c: char| !c.is_whitespace()) {
                let after = &rest[begin..];
                let end = after.find(char::is_whitespace).unwrap_or(after.len());
                tokens.push((&rest[..begin], &after[..end]));
                rest = &after[end..];
            }
            let indent = tokens.first().map_or("", |(gap, _)| *gap);
            let mut out = String::new();
            for (gap, token) in &tokens {
                if normalize_tag_name(token) != name {
                    out.push_str(if out.is_empty() { indent } else { gap });
                    out.push_str(token);
                }
            }
            if !out.is_empty() {
                out.push_str(rest);
                rewritten.push_str(&out);
                rewritten.push_str(eol);
                kept_lines += 1;
            }
        }
        if kept_lines > 0 {
            rewritten.push_str(&header.text[tag_bytes..]);
        }
        let old = &header.text;
        let prefix = shared_len(old.chars(), rewritten.chars());
        let suffix = shared_len(
            old[prefix..].chars().rev(),
            rewritten[prefix..].chars().rev(),
        );
        let from = header.start + prefix;
        let to = header.start + old.len() - suffix;
        self.edit_source(
            expected,
            from..to,
            &rewritten[prefix..rewritten.len() - suffix],
            None,
            accept,
        )
    }

    /// One isolated, accepted edit over plain text: undo restores the exact
    /// bytes and selection. The caret keeps its place around the edit, or lands
    /// at the source offset `caret_after` (valid after the edit) when given.
    pub(super) fn edit_source(
        &mut self,
        expected: Revision,
        source: std::ops::Range<usize>,
        inserted: &str,
        caret_after: Option<usize>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if self.composition().is_some() {
            return Err(EditorError::CompositionActive);
        }
        let range = DisplayRange {
            start: DisplayOffset(self.projection.display_at(source.start)),
            end: DisplayOffset(self.projection.display_at(source.end)),
        };
        let (selection, affinity) = (self.selection, self.affinity);
        let mut change = self.replace_action(
            expected,
            range,
            inserted,
            crate::InputAction::Isolated,
            accept,
        )?;
        let carry = |at: DisplayOffset| {
            DisplayOffset(if at.0 <= range.start.0 {
                at.0
            } else if at.0 >= range.end.0 {
                at.0 - (range.end.0 - range.start.0) + inserted.len()
            } else {
                range.start.0
            })
        };
        let kept = match caret_after {
            Some(source) => {
                let at = DisplayOffset(self.projection.display_at(source));
                DisplayRange { start: at, end: at }
            }
            None => DisplayRange {
                start: carry(selection.start),
                end: carry(selection.end),
            },
        };
        self.select_with_affinity(self.revision, kept, affinity)?;
        let (after_source, _) = self.capture_history_selection();
        let entry = self.undo.last_mut().and_then(|g| g.entries.last_mut());
        if let Some(entry) = entry {
            entry.after_selection = kept;
            entry.after_affinity = affinity;
            entry.after_source = after_source;
        }
        change.selection = kept;
        change.affinity = affinity;
        Ok(Some(change))
    }
}

/// Bytes of the leading characters two iterators share.
fn shared_len(a: impl Iterator<Item = char>, b: impl Iterator<Item = char>) -> usize {
    a.zip(b)
        .take_while(|(x, y)| x == y)
        .map(|(c, _)| c.len_utf8())
        .sum()
}
