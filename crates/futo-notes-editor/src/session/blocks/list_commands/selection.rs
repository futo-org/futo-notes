//! Validate header-lift endpoints in one actual-row preview before acceptance.
use super::*;
use std::ops::Range;

impl EditorSession {
    pub(in crate::session::blocks) fn commit_planned_prefix(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        footprint: Range<usize>,
        output: &str,
        shape: HeaderShape<'_>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let edits = [(0..footprint.len(), output.to_owned())];
        self.commit_planned_header(expected, range, footprint, &edits, output, shape, accept)
    }

    pub(in crate::session::blocks) fn commit_planned_header(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        footprint: Range<usize>,
        edits: &[(Range<usize>, String)],
        output: &str,
        shape: HeaderShape<'_>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let (selection, parsed, copied) =
            self.preview_header_selection(range, footprint.clone(), edits, output, Some(shape))?;
        let formats = (range == self.selection)
            .then(|| self.pending_formats.clone())
            .flatten();
        let affinity = self.input_affinity(range);
        let mut change = self.commit_block_edit(
            expected,
            footprint,
            output,
            BlockSelection::Display(selection),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        change.work.parsed_source_bytes += parsed;
        change.work.materialized_source_bytes += copied + output.len();
        Ok(change)
    }

    pub(in crate::session::blocks) fn preview_header_selection(
        &self,
        range: DisplayRange,
        footprint: Range<usize>,
        edits: &[(Range<usize>, String)],
        output: &str,
        shape: Option<HeaderShape<'_>>,
    ) -> Result<(DisplayRange, usize, usize), EditorError> {
        let points = [
            self.projection.retained_point(range.start.0)?,
            self.projection.retained_point(range.end.0)?,
        ];
        let mut bounds = footprint.clone();
        for point in points {
            crate::inline::visit_container();
            let extent = point.extent();
            bounds.start = bounds.start.min(extent.start);
            bounds.end = bounds.end.max(extent.end);
        }
        let (window, display) = self.projection.retained_point_window(bounds);
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut preview = self.stage_source(&raw, window.clone());
        let edit = preview.prepare_source(
            preview.revision(),
            SourceRange {
                start: SourceOffset(footprint.start - window.start),
                end: SourceOffset(footprint.end - window.start),
            },
            output,
        )?;
        // This private apply calls no host, clock or history operation.
        let old_display_len = preview.projection.display.len_bytes();
        let work = preview.apply(&edit).work;
        if let Some(shape) = shape {
            let body = if let HeaderShape::ParagraphList {
                body,
                inserted_at,
                newline,
                ..
            }
            | HeaderShape::ParagraphPlain {
                body,
                inserted_at,
                newline,
                ..
            } = shape
            {
                let (cut, text) = edits.first().ok_or(EditorError::UnrepresentableFormat)?;
                if cut.start != 0 || footprint.start + cut.end != body {
                    return Err(EditorError::UnrepresentableFormat);
                }
                if preview.projection.display.len_bytes() != old_display_len + newline.len() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                let at = inserted_at
                    .checked_sub(display)
                    .filter(|at| *at <= old_display_len)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                let before = self
                    .projection
                    .display
                    .byte_slice(display..display + old_display_len);
                if at > before.len_bytes()
                    || !before
                        .byte_slice(..at)
                        .bytes()
                        .chain(newline.bytes())
                        .chain(before.byte_slice(at..).bytes())
                        .zip(preview.projection.display.bytes())
                        .all(|(a, b)| {
                            crate::inline::visit_container();
                            a == b
                        })
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
                footprint.start - window.start + text.len()
            } else {
                footprint.start - window.start + output.len()
            };
            let actual = preview
                .projection
                .list_command_line_at_source(body)
                .ok_or(EditorError::UnrepresentableFormat)?;
            crate::inline::visit_container();
            let quotes = match shape {
                HeaderShape::List { quotes, .. }
                | HeaderShape::ParagraphList { quotes, .. }
                | HeaderShape::ParagraphPlain { quotes, .. }
                | HeaderShape::Plain { quotes, .. } => quotes,
            };
            if actual.code
                || actual.divider
                || actual.heading != 0
                || actual.quote_depth != quotes
                || actual.content.start != body
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            match shape {
                HeaderShape::List { original, .. }
                | HeaderShape::ParagraphList { original, .. } => {
                    let first = match shape {
                        HeaderShape::List { first, .. }
                        | HeaderShape::ParagraphList { first, .. } => first,
                        _ => unreachable!(),
                    };
                    let owned = actual
                        .list
                        .as_ref()
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    if owned.depth != original.depth
                        || owned.ordinal != original.ordinal
                        || owned.checked != original.checked
                        || owned.first != first
                        || owned.marker.start
                            != original
                                .marker
                                .start
                                .checked_sub(window.start)
                                .ok_or(EditorError::UnrepresentableFormat)?
                        || owned.owner.start
                            != original
                                .owner
                                .start
                                .checked_sub(window.start)
                                .ok_or(EditorError::UnrepresentableFormat)?
                        || owned.item.start
                            != original
                                .item
                                .start
                                .checked_sub(window.start)
                                .ok_or(EditorError::UnrepresentableFormat)?
                    {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                }
                HeaderShape::Plain { earlier, .. }
                | HeaderShape::ParagraphPlain { earlier, .. } => {
                    if actual.list.is_some() {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    if let Some((at, number)) = earlier {
                        let at = at
                            .checked_sub(window.start)
                            .ok_or(EditorError::UnrepresentableFormat)?;
                        let parent = preview
                            .projection
                            .list_command_line_at_source(at)
                            .ok_or(EditorError::UnrepresentableFormat)?;
                        crate::inline::visit_container();
                        if parent.code
                            || parent.divider
                            || parent.heading != 0
                            || parent.quote_depth != 0
                            || !parent.content.is_empty()
                            || !parent.list.as_ref().is_some_and(|list| {
                                list.first
                                    && list.depth == 1
                                    && list.ordinal == number
                                    && list.marker.start == at
                            })
                        {
                            return Err(EditorError::UnrepresentableFormat);
                        }
                    }
                }
            }
        }
        let paragraph = match shape {
            Some(HeaderShape::ParagraphList {
                original, quotes, ..
            }) => Some((Some(original), quotes)),
            Some(HeaderShape::ParagraphPlain { quotes, .. }) => Some((None, quotes)),
            _ => None,
        };
        if let Some((original, quotes)) = paragraph {
            let (cut, text) = edits.first().ok_or(EditorError::UnrepresentableFormat)?;
            if cut.start != 0 {
                return Err(EditorError::UnrepresentableFormat);
            }
            let first = preview
                .projection
                .list_command_line_at_source(footprint.start - window.start + text.len())
                .ok_or(EditorError::UnrepresentableFormat)?;
            let mut at = first.source.end;
            let end = footprint.start - window.start + output.len();
            while at < end {
                let actual = preview
                    .projection
                    .list_command_line_at_source(at)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                crate::inline::visit_container();
                if actual.source.start != at
                    || actual.source.end <= at
                    || actual.source.end > end
                    || actual.code
                    || actual.divider
                    || actual.heading != 0
                    || actual.quote_depth != quotes
                    || !match original {
                        None => actual.list.is_none(),
                        Some(original) => actual.list.as_ref().is_some_and(|list| {
                            !list.first
                                && list.depth == original.depth
                                && list.ordinal == original.ordinal
                                && list.checked == original.checked
                                && list.marker.start + window.start == original.marker.start
                                && list.owner.start + window.start == original.owner.start
                                && list.item.start + window.start == original.item.start
                        }),
                    }
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
                at = actual.source.end;
            }
            if at != end {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        let mut mapped = [0; 2];
        for (index, point) in points.into_iter().enumerate() {
            let shifted = point
                .through_edits(footprint.start, edits)?
                .relative(window.start)?;
            point.verify_raw(&self.source, shifted, &preview.source)?;
            mapped[index] = display + preview.projection.project_retained_point(shifted)?;
        }
        Ok((
            DisplayRange {
                start: DisplayOffset(mapped[0]),
                end: DisplayOffset(mapped[1]),
            },
            2 * raw.len() + work.parsed_source_bytes,
            raw.len() + output.len() + work.materialized_source_bytes,
        ))
    }
}

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn header_atom_preview_excludes_unrelated_rows_and_counts_real_source_work() {
        let mut measured = Vec::new();
        for count in [1, 20_000] {
            let prefix = "foreign\n\n".repeat(count);
            let raw = format!("{prefix}- > &acE;");
            let expected = format!("{prefix}\n> &acE;");
            let before = format!("{prefix}\u{223e}\u{0333}");
            let shown = format!("{prefix}\n\u{223e}\u{0333}");
            let mut s = EditorSession::open(&raw);
            assert_eq!(s.display_text(), before);
            let selected = DisplayRange {
                start: DisplayOffset(prefix.len() + 3),
                end: DisplayOffset(prefix.len() + 3),
            };
            s.select_with_affinity(Revision(0), selected, Affinity::Backward)
                .unwrap();
            crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.set(0));
            let mut accepted = 0;
            let change = s
                .block_command(
                    Revision(0),
                    selected,
                    BlockCommand::Heading(0),
                    &mut |edit| {
                        accepted += 1;
                        assert!(edit.range.start.0 >= prefix.len());
                        Ok(())
                    },
                )
                .unwrap()
                .unwrap();
            let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.get());
            let mut view = before.clone();
            view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(accepted, 1);
            assert_eq!(view, shown);
            assert_eq!(s.source_text(), expected);
            assert_eq!(
                s.selection(),
                DisplayRange {
                    start: DisplayOffset(prefix.len() + 4),
                    end: DisplayOffset(prefix.len() + 4),
                }
            );
            assert!(visits > 0 && visits < 4096, "metadata={visits}");
            assert!(
                change.work.parsed_source_bytes > 0 && change.work.parsed_source_bytes < 4096,
                "parsed={}",
                change.work.parsed_source_bytes
            );
            assert!(
                change.work.materialized_source_bytes > 0
                    && change.work.materialized_source_bytes < 4096,
                "copied={}",
                change.work.materialized_source_bytes
            );
            measured.push((
                change.work.parsed_source_bytes,
                change.work.materialized_source_bytes,
            ));
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.selection(), selected);
            assert_eq!(s.affinity(), Affinity::Backward);
        }
        assert_eq!(measured[0], measured[1]);
    }

    #[test]
    fn one_header_preview_uses_bounded_passes_over_its_actual_large_list_row() {
        let mut measured = Vec::new();
        for count in [64, 512] {
            let tail = (0..count)
                .map(|i| format!("- p{i}"))
                .collect::<Vec<_>>()
                .join("\n");
            let tail_view = (0..count)
                .map(|i| format!("p{i}"))
                .collect::<Vec<_>>()
                .join("\n");
            let raw = format!("- > &acE;\n{tail}");
            let expected = format!("\n> &acE;\n{tail}");
            let before = format!("\u{223e}\u{0333}\n{tail_view}");
            let shown = format!("\n{before}");
            assert_eq!(EditorSession::open(&expected).display_text(), shown);
            let mut s = EditorSession::open(&raw);
            assert_eq!(s.display_text(), before);
            let selected = DisplayRange {
                start: DisplayOffset(3),
                end: DisplayOffset(3),
            };
            s.select_with_affinity(Revision(0), selected, Affinity::Backward)
                .unwrap();
            crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.set(0));
            let mut accepted = 0;
            let change = s
                .block_command(Revision(0), selected, BlockCommand::Heading(0), &mut |_| {
                    accepted += 1;
                    Ok(())
                })
                .unwrap()
                .unwrap();
            let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.get());
            let mut view = before.clone();
            view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(accepted, 1);
            assert_eq!(view, shown);
            assert_eq!(s.source_text(), expected);
            assert_eq!(
                s.selection(),
                DisplayRange {
                    start: DisplayOffset(4),
                    end: DisplayOffset(4)
                }
            );
            let p = s
                .project(
                    s.revision(),
                    DisplayRange {
                        start: DisplayOffset(0),
                        end: DisplayOffset(shown.len()),
                    },
                )
                .unwrap();
            assert_eq!(
                p.blocks
                    .iter()
                    .filter_map(|b| b.list.as_ref().filter(|l| l.first))
                    .count(),
                count
            );
            assert!(
                visits > 0 && visits < 128 * raw.len(),
                "count={count} metadata={visits}"
            );
            assert!(
                change.work.parsed_source_bytes < 32 * raw.len(),
                "count={count} parsed={}",
                change.work.parsed_source_bytes
            );
            assert!(
                change.work.materialized_source_bytes < 32 * raw.len(),
                "count={count} copied={}",
                change.work.materialized_source_bytes
            );
            measured.push((raw.len(), visits));
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.selection(), selected);
            assert_eq!(s.affinity(), Affinity::Backward);
        }
        let (a_bytes, a) = measured[0];
        let (b_bytes, b) = measured[1];
        assert!(
            (b as u128) * (a_bytes as u128) < 2 * (a as u128) * (b_bytes as u128),
            "header row input={a_bytes}..{b_bytes} metadata={a}..{b}"
        );
    }
}
