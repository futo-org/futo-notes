use super::*;

impl EditorSession {
    pub(in crate::session) fn input_before_lazy_quote_neighbor(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<(ViewChange, InputMapping)>, EditorError> {
        if inserted
            .split(['\r', '\n'])
            .next()
            .unwrap_or("")
            .trim_matches([' ', '\t'])
            .is_empty()
        {
            return Ok(None);
        }
        let Some(line) = self.projection.block_lines(range).into_iter().next() else {
            return Ok(None);
        };
        if line.code
            || line.heading > 0
            || line.divider
            || !self
                .source
                .byte_slice(line.content.clone())
                .chars()
                .all(|ch| matches!(ch, ' ' | '\t'))
            || range.end.0 > self.projection.display_at(line.content.end)
        {
            return Ok(None);
        }
        let before = line.quote_depth == 0;
        let (separator, copied) = if before {
            let row = self.source.byte_to_line(line.source.start);
            if row == 0 {
                return Ok(None);
            }
            let previous = self.source.line_to_byte(row - 1);
            let at = DisplayOffset(self.projection.display_at(previous));
            if !self
                .projection
                .block_lines(DisplayRange { start: at, end: at })
                .iter()
                .any(|line| line.quote_depth > 0)
            {
                return Ok(None);
            }
            let ending = if self.source.line(row - 1).to_string().ends_with("\r\n") {
                "\r\n"
            } else {
                "\n"
            };
            (ending.to_owned(), ending.len())
        } else {
            let Some(boundary) =
                self.quote_neighbor_separator(line.source.end, line.quote_depth, true)
            else {
                return Ok(None);
            };
            boundary
        };
        let change = self.stage_mapped_block_action(
            expected,
            range,
            Some(HistoryInput {
                range,
                inserted,
                action,
            }),
            accept,
            |staged, local, accept| {
                let line = staged.projection.block_lines(local).remove(0);
                let formats = staged.pending_formats.clone();
                let affinity = staged.affinity;
                let (at, selection) = if before {
                    let start = staged.projection.source_bounds(local.start.0).1;
                    let end = if local.start == local.end {
                        start
                    } else {
                        staged.projection.source_bounds(local.end.0).0
                    };
                    (
                        line.source.start,
                        BlockSelection::SourceRange(start + separator.len()..end + separator.len()),
                    )
                } else {
                    (line.source.end, BlockSelection::Display(local))
                };
                let mut boundary = staged.commit_block_edit(
                    staged.revision(),
                    at..at,
                    &separator,
                    selection,
                    None,
                    accept,
                )?;
                staged.carry_block_state(&mut boundary, formats, affinity);
                let local = staged.selection();
                let (mut input, mapping) = staged.replace_action_mapped(
                    staged.revision(),
                    local,
                    inserted,
                    action,
                    accept,
                )?;
                let mapping = mapping.with_source_boundary(&boundary);
                input.work.materialized_source_bytes += boundary.work.materialized_source_bytes;
                input.work.parsed_source_bytes += boundary.work.parsed_source_bytes;

                input.work.link_metadata_items += boundary.work.link_metadata_items;

                input.work.link_copied_bytes += boundary.work.link_copied_bytes;
                Ok(Some((input, mapping)))
            },
        )?;
        Ok(change.map(|(mut change, mapping)| {
            change.work.materialized_source_bytes += copied;
            (change, mapping)
        }))
    }

    pub(in crate::session) fn input_at_divider(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if range.start != range.end || inserted.is_empty() {
            return Ok(None);
        }
        let Some(line) = self
            .projection
            .block_lines(range)
            .into_iter()
            .find(|line| line.divider)
        else {
            return Ok(None);
        };
        let before = range.start.0 == self.projection.display_at(line.content.start);
        let after = range.start.0 == self.projection.display_at(line.content.end);
        if !before && !after {
            return Ok(None);
        }
        let mut staged = self.stage_source(
            "",
            if before {
                line.source.start..line.source.start
            } else {
                line.content.end..line.content.end
            },
        )?;
        staged.affinity = self.input_affinity(range);
        if range == self.selection {
            staged.pending_formats = self.pending_formats.clone();
        }
        let input = staged.replace_action(
            staged.revision(),
            DisplayRange::default(),
            inserted,
            action,
            &mut |_| Ok(()),
        )?;
        let raw = staged.source_text();
        let quote = "> ".repeat(line.quote_depth);
        let (at, text, caret) = if before {
            (
                line.source.start,
                format!("{quote}{raw}\n"),
                line.source.start + quote.len() + raw.len(),
            )
        } else {
            (
                line.content.end,
                format!("\n{quote}{raw}"),
                line.content.end + 1 + quote.len() + raw.len(),
            )
        };
        let dash_divider = before
            && self
                .source
                .byte_slice(line.content.clone())
                .to_string()
                .trim_start()
                .starts_with('-');
        let (footprint, text) = if dash_divider {
            (
                line.source.start..line.content.end,
                format!("{text}{quote}***"),
            )
        } else {
            (at..at, text)
        };
        // The stage's complete raw output is inserted unchanged after the
        // explicit separator/quote prefix. This is source-byte correspondence,
        // not an arithmetic mapping through a derived inline body.
        let body_start = if before {
            line.source.start + quote.len()
        } else {
            line.content.end + 1 + quote.len()
        };
        let pending = staged.prepare_pending_for_parent(body_start);
        let mut change = self.commit_block_with_pending(
            expected,
            footprint,
            &text,
            BlockSelection::Source(caret),
            Some(HistoryInput {
                range,
                inserted,
                action,
            }),
            Some(pending),
            accept,
        )?;
        self.carry_block_state(&mut change, staged.pending_formats, staged.affinity);
        change.work.materialized_source_bytes += input.work.materialized_source_bytes;
        change.work.parsed_source_bytes += input.work.parsed_source_bytes;

        change.work.link_metadata_items += input.work.link_metadata_items;

        change.work.link_copied_bytes += input.work.link_copied_bytes;
        Ok(Some(change))
    }

    pub(in crate::session) fn line_start_conversion(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        query_work: &mut crate::inline::references::ReferenceWork,
    ) -> Result<Option<ViewChange>, EditorError> {
        if let Some(change) = self.fence_conversion(expected, range, inserted, accept)? {
            return Ok(Some(change));
        }
        if range.start != range.end {
            return Ok(None);
        }
        let Some(line) = self.projection.block_lines(range).into_iter().next() else {
            return Ok(None);
        };
        // Raw HTML keeps typed Markdown markers literal.
        if line.code || line.html || line.heading > 0 || line.divider {
            return Ok(None);
        }
        let start_display = self.projection.display_at(line.content.start);
        // Every conversion below needs a short prefix after its indentation
        // (at most `123456789. `): a caret deep in a long line converts
        // nothing, so its line is not read or queried.
        let indent = self
            .projection
            .display
            .byte_slice(start_display..range.start.0)
            .bytes()
            .take_while(|byte| matches!(byte, b' ' | b'\t'))
            .count();
        if range.start.0 - start_display - indent + inserted.len() > SHORTCUT_MAX {
            return Ok(None);
        }
        let mut prefix = self
            .projection
            .display
            .byte_slice(start_display..range.start.0)
            .to_string();
        prefix.push_str(inserted);
        let prefix_range = DisplayRange {
            start: DisplayOffset(start_display),
            end: range.start,
        };
        let (prefix_projection, measured) = self
            .projection
            .query_with_work(self.revision(), prefix_range);
        query_work.parsed += measured.parsed;
        query_work.items += measured.items;
        query_work.copied += measured.copied;
        if prefix_projection
            .runs
            .iter()
            .any(|run| run.formats.contains(&InlineFormat::Code))
            || range == self.selection
                && self
                    .pending_formats
                    .as_ref()
                    .is_some_and(|formats| formats.contains(&InlineFormat::Code))
        {
            return Ok(None);
        }
        if let Some(change) = self.list_conversion(expected, range, &prefix, accept)? {
            return Ok(Some(change));
        }
        let heading = prefix
            .strip_suffix(' ')
            .filter(|s| !s.is_empty() && s.len() <= 6 && s.bytes().all(|ch| ch == b'#'));
        let quote = prefix == "> ";
        let divider = matches!(prefix.as_str(), "---" | "___ " | "*** ")
            && range.start.0 == self.projection.display_at(line.content.end);
        if heading.is_none() && !quote && !divider {
            return Ok(None);
        }
        if (heading.is_some() || quote) && line.list.is_some() {
            return self.marker_in_item(expected, range, heading.map(str::len), accept);
        }
        let command = if let Some(hashes) = heading {
            BlockCommand::Heading(hashes.len() as u8)
        } else if quote {
            BlockCommand::Quote
        } else {
            BlockCommand::Divider
        };
        self.stage_block_action(expected, range, None, accept, |staged, local, accept| {
            let line = staged.projection.block_lines(local).remove(0);
            let prefix = DisplayRange {
                start: DisplayOffset(staged.projection.display_at(line.content.start)),
                end: local.start,
            };
            let removed = staged.replace_action(
                staged.revision(),
                prefix,
                "",
                crate::InputAction::Isolated,
                accept,
            )?;
            let formats = staged.pending_formats.clone();
            let mut change = staged
                .block_command(staged.revision(), staged.selection(), command, accept)?
                .ok_or(EditorError::UnrepresentableFormat)?;
            staged.pending_formats = formats;
            change.work.materialized_source_bytes += removed.work.materialized_source_bytes;
            change.work.parsed_source_bytes += removed.work.parsed_source_bytes;

            change.work.link_metadata_items += removed.work.link_metadata_items;

            change.work.link_copied_bytes += removed.work.link_copied_bytes;
            Ok(Some(change))
        })
    }
}

impl EditorSession {
    /// A keyboard commit such as `- [ ] spinach` into an empty list item reads
    /// as if typed one character at a time, so its leading list marker
    /// changes the item's kind, as a paste does; the commit is one Undo step.
    pub(in crate::session) fn marker_committed_into_empty_item(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let marker = inserted.split_once(' ').map(|(marker, _)| marker);
        let starts_list = marker.is_some_and(|marker| {
            matches!(marker, "-" | "+" | "*")
                || marker.strip_suffix('.').is_some_and(|digits| {
                    (1..=9).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
                })
        });
        if !starts_list
            || range.start != range.end
            || inserted.len() <= 2
            || inserted.contains(['\r', '\n'])
        {
            return Ok(None);
        }
        let Some(line) = self.projection.block_lines(range).into_iter().next() else {
            return Ok(None);
        };
        if line.list.is_none()
            || line.code
            || line.html
            || line.content.start != line.content.end
            || range.start.0 != self.projection.display_at(line.content.start)
        {
            return Ok(None);
        }
        self.stage_block_action(expected, range, None, accept, |staged, _, accept| {
            let mut last = None;
            for ch in inserted.chars() {
                let mut buffer = [0; 4];
                last = Some(staged.replace_action(
                    staged.revision(),
                    staged.selection(),
                    ch.encode_utf8(&mut buffer),
                    crate::InputAction::Typing,
                    accept,
                )?);
            }
            Ok(last)
        })
    }

    /// `## ` or `> ` typed at the start of a list item's text writes a heading
    /// or quote inside that item, where CommonMark reads it. Where it cannot
    /// (after a task checkbox) the shortcut declines and the space lands as
    /// literal text.
    fn marker_in_item(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        heading: Option<usize>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let affinity = self.input_affinity(range);
        self.stage_block_action(expected, range, None, accept, |staged, local, accept| {
            let line = staged.projection.block_lines(local).remove(0);
            let (caret, _) = staged.projection.source_selection(local, affinity);
            let marker = heading.map_or_else(|| "> ".to_owned(), |n| "#".repeat(n) + " ");
            let at = line.content.start;
            let end = at + marker.len();
            // A caret before the item's hidden marker still types into it.
            let typed = caret.start.source.0.max(at);
            let change = staged.commit_block_edit(
                staged.revision(),
                at..typed,
                &marker,
                BlockSelection::Source(end),
                None,
                accept,
            )?;
            let line = staged.projection.block_lines(staged.selection()).remove(0);
            let reads = line.list.is_some()
                && match heading {
                    Some(n) => usize::from(line.heading) == n,
                    None => line.quote_depth > 0,
                };
            Ok(reads.then_some(change))
        })
    }
}

/// The longest prefix a line-start shortcut reads after its indentation.
const SHORTCUT_MAX: usize = "123456789. ".len();
