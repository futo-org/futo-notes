//! Tag queries and header-tag edits. Tags are the line reader's tag marks
//! (the canonical `futo-notes-tags` grammar, none inside code); the header
//! block is the canonical `extract_header_tag_block` read from the body's
//! first lines. Front matter is never a tag source and never edited here.
use super::trimmed;
use crate::engine::command::{Command, Edit};
use crate::engine::Engine;
use crate::lines::{FrontMatterRole, Kind, SpanKind};
use crate::{EditorError, Revision, SourceEdit, ViewChange};
use futo_notes_tags::{extract_header_tag_block, is_valid_tag_name, normalize_tag_name};
use std::collections::HashSet;

/// The leading header tag block.
struct Header {
    /// Source offset where the block starts: the body's start.
    start: usize,
    /// Canonical tags (`#name`), first-seen order, deduplicated.
    tags: Vec<String>,
    /// The block's exact text, with a trailing blank separator line.
    text: String,
}

type Accept<'a> = &'a mut dyn FnMut(&SourceEdit) -> Result<(), String>;

impl Engine {
    /// The body's first line and its source start: the line after closed
    /// front matter, else line 1. Tags are read and edited only from here.
    fn body(&self) -> (usize, usize) {
        if self.line(0).line.kind != Kind::FrontMatter(FrontMatterRole::Open) {
            return (0, 0);
        }
        let close = self
            .store
            .iter_from(0)
            .position(|entry| entry.line.kind == Kind::FrontMatter(FrontMatterRole::Close));
        match close {
            Some(close) if close + 1 < self.line_count() => (close + 1, self.line_start(close + 1)),
            Some(close) => (close, self.source_len()),
            None => (0, 0),
        }
    }

    /// Canonical tags (`#name`) of the body, in first-seen order. An
    /// on-demand scan; no edit runs one.
    pub(crate) fn tags(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut tags = Vec::new();
        for entry in self.store.iter_from(self.body().0) {
            for span in &entry.spans {
                if span.kind == SpanKind::Tag {
                    let name =
                        normalize_tag_name(&entry.text[span.range.start + 1..span.range.end]);
                    if seen.insert(name.clone()) {
                        tags.push(format!("#{name}"));
                    }
                }
            }
        }
        tags
    }

    /// Canonical tags of the leading header tag block.
    pub(crate) fn header_tags(&self) -> Vec<String> {
        self.header().tags
    }

    /// The header block, read from its own lines and the one after them.
    fn header(&self) -> Header {
        let (first, start) = self.body();
        let mut text = String::new();
        if start < self.source_len() {
            for entry in self.store.iter_from(first) {
                text.push_str(&entry.text);
                if extract_header_tag_block(&entry.text).tags.is_empty() {
                    break;
                }
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

    /// Add a tag to the header block, creating the block (with its blank
    /// separator) when absent. The tag is normalized; one already present
    /// changes nothing.
    pub(crate) fn add_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let name = normalize_tag_name(tag);
        if !is_valid_tag_name(&name) {
            return Err(EditorError::InvalidText);
        }
        let header = self.header();
        if header.tags.contains(&format!("#{name}")) {
            return Ok(None);
        }
        let edit = if header.tags.is_empty() {
            let (line, at) = self.body();
            let eol = self.empty_line_ending(line);
            // Front matter closed on the note's last line: start a line.
            let lead = if at > 0 && !self.source_slice(at - 1..at).ends_with('\n') {
                eol.as_str()
            } else {
                ""
            };
            let tail = if at == self.source_len() { "" } else { &eol };
            Edit::insert(at, format!("{lead}#{name}{tail}{tail}"))
        } else {
            let (offset, last) = header
                .text
                .split_inclusive('\n')
                .scan(0, |at, line| {
                    let start = *at;
                    *at += line.len();
                    Some((start, line))
                })
                .filter(|(_, line)| !line.trim().is_empty())
                .last()
                .expect("a header with tags has a tag line");
            Edit::insert(
                header.start + offset + last.trim_end().len(),
                format!(" #{name}"),
            )
        };
        self.header_edit(expected, edit, accept)
    }

    /// Remove every spelling of a tag from the header block, keeping all
    /// other bytes. A line left without tags goes; an emptied block also
    /// drops its blank separator.
    pub(crate) fn remove_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let name = normalize_tag_name(tag);
        let header = self.header();
        if !header.tags.contains(&format!("#{name}")) {
            return Ok(None);
        }
        let mut rewritten = String::new();
        let mut kept_lines = 0;
        let mut tag_bytes = 0;
        for line in header.text.split_inclusive('\n') {
            if line.trim().is_empty() {
                continue; // the separator, kept below only while tags remain
            }
            tag_bytes += line.len();
            let body = line.trim_end_matches(['\n', '\r']);
            let eol = &line[body.len()..];
            // (whitespace before, token) pairs, then the trailing whitespace.
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
        let edit = trimmed(header.start, &header.text, &rewritten);
        self.header_edit(expected, edit, accept)
    }

    /// Run one header edit as a command naming the lines it changes; the
    /// selection keeps its place around it.
    fn header_edit(
        &mut self,
        expected: Revision,
        edit: Edit,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        let lines = self.line_of(edit.range.start)..self.line_of(edit.range.end) + 1;
        let mut command = Command::new(vec![edit], lines, 0..0);
        let selection = self.source_selection(self.selection);
        command.selection = command.map(selection.start, false)..command.map(selection.end, false);
        command.affinity = Some(self.affinity);
        let change = self.run(expected, |_| Ok(Some(command)), accept)?;
        Ok(change.map(|change| self.view(change)))
    }
}
