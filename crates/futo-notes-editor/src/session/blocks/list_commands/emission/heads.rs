//! Selected-body retirement, marker spelling and immediate owner boundaries.
use super::*;

struct HeadEdit {
    prefix: String,
    retained: usize,
    text: String,
    empty_quote: bool,
    independent_number: Option<u64>,
}

impl ListEmitter<'_> {
    fn line_at(&self, at: usize) -> Option<crate::inline::blocks::ListCommandLine> {
        self.session
            .projection
            .list_command_line_at_source(at)
            .filter(|line| !line.empty_comment)
    }

    pub(super) fn emit_head(
        &mut self,
        index: usize,
        line: &crate::inline::blocks::ListCommandLine,
    ) -> Result<(), EditorError> {
        let remove = self.targets.removes(line) || self.lift.promotes_ancestor(line.source.start);
        self.retire_body(line, remove);
        let mut head = self.head_spelling(index, line, remove)?;
        self.preserve_head_neighbors(line, remove, &mut head);
        self.record_column_shift(line, remove, &head.text);
        self.materialized += head.text.len();
        self.heads
            .insert(line.source.start, (self.replacements.len(), remove));
        self.replacements.push((
            line.source.start - self.start..line.content.start - self.start,
            head.text,
        ));
        Ok(())
    }

    fn retire_body(&mut self, line: &crate::inline::blocks::ListCommandLine, remove: bool) {
        let command = self.command;
        if line.heading > 0 {
            // ATX closing hashes and a setext underline belong to the
            // retired heading; retain its final physical line ending.
            let raw = self
                .session
                .source
                .byte_slice(line.source.clone())
                .to_string();
            let end = line.source.start + raw.trim_end_matches(['\r', '\n']).len();
            self.replacements.push((
                line.content.end - self.start..end - self.start,
                String::new(),
            ));
            self.materialized += raw.len();
        }
        let (body, work, copied) =
            self.session
                .list_command_body(line.content.clone(), command, remove);
        self.parsed += work;
        self.materialized += copied;
        if let Some(body) = body {
            self.replacements.push((
                line.content.start - self.start..line.content.end - self.start,
                body,
            ));
        }
    }

    fn head_spelling(
        &mut self,
        index: usize,
        line: &crate::inline::blocks::ListCommandLine,
        remove: bool,
    ) -> Result<HeadEdit, EditorError> {
        let command = self.command;
        let prefix = self
            .session
            .source
            .byte_slice(line.source.start..line.content.start)
            .to_string();
        self.materialized += prefix.len();
        let retained = self.session.list_retained_prefix(
            line,
            &prefix,
            remove,
            self.styles
                .as_ref()
                .map_or(0, |styles| styles.quotes[index]),
        );
        let default_number = self
            .styles
            .as_ref()
            .map_or(1, |styles| styles.ordinals[index]);
        let (ordered_number, ordered_head) =
            line.list.as_ref().map_or((default_number, false), |list| {
                if command == BlockCommand::OrderedList && !remove {
                    self.lift
                        .ordered_number(list, self.styles.as_ref().unwrap().ordinals[index])
                } else {
                    (1, false)
                }
            });
        let marker = if remove {
            String::new()
        } else {
            self.session.list_command_marker(
                line,
                command,
                &prefix,
                retained,
                (
                    self.styles.as_ref().unwrap().markers[index],
                    ordered_number,
                    ordered_head,
                ),
            )
        };
        let (replacement, empty_quote) = if let Some(quote) = self
            .session
            .lift_same_line_quote_prefix(line, &prefix, remove)?
        {
            self.preview_header = true;
            (quote, true)
        } else {
            (format!("{}{marker}", &prefix[..retained]), false)
        };
        Ok(HeadEdit {
            prefix,
            retained,
            text: replacement,
            empty_quote,
            independent_number: ordered_head.then_some(ordered_number),
        })
    }

    fn preserve_head_neighbors(
        &mut self,
        line: &crate::inline::blocks::ListCommandLine,
        remove: bool,
        head: &mut HeadEdit,
    ) {
        let mixed = !self.remove;
        if head.independent_number.is_some_and(|number| number != 1) {
            let physical = self.session.source.byte_to_line(line.source.start);
            let separated = physical > 0
                && self
                    .session
                    .projection
                    .source_prefix_at(self.session.source.line_to_byte(physical - 1))
                    .is_some_and(|previous| {
                        !previous.code
                            && previous.quote_depth == line.quote_depth
                            && self
                                .session
                                .source
                                .byte_slice(previous.content)
                                .chars()
                                .all(|ch| {
                                    crate::inline::visit_container();
                                    ch.is_whitespace()
                                })
                    });
            if !separated {
                head.text
                    .insert_str(0, &format!("{}\n", head.prefix[..head.retained].trim_end()));
                self.separators
                    .push(self.session.projection.display_at(line.source.start));
            }
        }
        if remove {
            if let Some(list) = &line.list {
                let index = self.session.source.byte_to_line(line.source.start);
                if index > 0 && !head.empty_quote {
                    let previous = self.session.source.line_to_byte(index - 1);
                    if self
                        .session
                        .source
                        .byte_slice(previous..line.source.start)
                        .chars()
                        .any(|ch| {
                            crate::inline::visit_container();
                            !ch.is_whitespace()
                        })
                        && self
                            .line_at(previous)
                            .and_then(|line| line.list)
                            .is_some_and(|previous| {
                                !self.targets.retires_item(&previous)
                                    && (previous.owner == list.owner
                                        || mixed
                                            && previous.quote_depth == list.quote_depth
                                            && self.lift.depth_for(&previous, self.targets)
                                                == if self.lift.starts_paragraph(line.source.start)
                                                {
                                                    1
                                                } else {
                                                    self.targets.output_depth(list)
                                                })
                            })
                    {
                        head.text.insert_str(
                            0,
                            &format!("{}\n", head.prefix[..head.retained].trim_end()),
                        );
                        self.separators
                            .push(self.session.projection.display_at(line.source.start));
                    }
                }
                if line.source.end < self.session.source.len_bytes() {
                    if let Some(next) = self.line_at(line.source.end).and_then(|line| line.list) {
                        if next.owner == list.owner
                            && !self.targets.retires_item(&next)
                            && next.ordinal.is_some()
                            && self
                                .session
                                .source
                                .byte_slice(next.marker.start..next.marker.end - 1)
                                .to_string()
                                .parse::<u64>()
                                .ok()
                                != Some(1)
                        {
                            self.replacements.push((
                                line.source.end - self.start..line.source.end - self.start,
                                format!("{}\n", head.prefix[..head.retained].trim_end()),
                            ));
                            self.separators
                                .push(self.session.projection.display_at(line.source.end));
                        }
                    }
                }
            }
        }
    }

    fn record_column_shift(
        &mut self,
        line: &crate::inline::blocks::ListCommandLine,
        remove: bool,
        head: &str,
    ) {
        let (command, mixed) = (self.command, !self.remove);
        if remove && mixed {
            if let Some(list) = line.list.as_ref().filter(|list| list.first) {
                // Removing the item also removes its owned indentation
                // contribution from every continuation/descendant prefix.
                // Retargeted descendant markers join this same sweep.
                let delta = list.marker_column as isize - list.content_column as isize;
                self.shifts.push(indent_source::OwnedPrefixShift {
                    start: line.source.end,
                    item: list.item.clone(),
                    quote: list.quote_depth,
                    owner_depth: list.depth,
                    delta,
                });
            }
        } else if !remove {
            if let Some(list) = &line.list {
                let logical_end = head.len() - usize::from(command == BlockCommand::TaskList) * 4;
                let column = crate::inline::columns(&head[..logical_end], 0);
                let delta = column as isize - list.content_column as isize;
                if delta != 0 {
                    self.shifts.push(indent_source::OwnedPrefixShift {
                        start: line.source.end,
                        item: list.item.clone(),
                        quote: list.quote_depth,
                        owner_depth: list.depth,
                        delta,
                    });
                }
            }
        }
    }
}
