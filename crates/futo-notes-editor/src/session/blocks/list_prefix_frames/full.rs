//! Full-toolbar list retirement through a complete quoted paragraph.
use super::*;

impl EditorSession {
    pub(super) fn plan_full_prefix_frame<'a>(
        &self,
        line: &'a crate::inline::blocks::ListCommandLine,
        items: &[crate::inline::ListLine],
        paragraph: std::ops::Range<usize>,
    ) -> Result<Option<FramePlan<'a>>, EditorError> {
        let list = line.list.as_ref().unwrap();
        let same_quote = list.depth == 2 && list.quote_depth == 0;
        let cross_quote = list.depth == 2 && list.quote_depth == 1;
        if line.quote_depth != 1
            || !(list.depth == 1 && list.quote_depth == 0 || same_quote || cross_quote)
            || list.item.end != paragraph.end
        {
            return Ok(None);
        }
        let prefix = self
            .source
            .byte_slice(line.source.start..line.content.start)
            .to_string();
        let Some(newline) = self.full_frame_newline(line) else {
            return Ok(None);
        };
        let mut shifts = std::collections::BTreeMap::new();
        let mut output = if same_quote {
            format!(
                "{}{newline}{newline}",
                &prefix[..list.marker.start - line.source.start]
            )
        } else {
            newline.to_owned()
        };
        let mut at = 0;
        let mut root = None;
        for item in items {
            crate::inline::visit_container();
            if item.item.start <= list.marker.start && list.marker.start < item.item.end {
                if item.item.end != paragraph.end
                    || item.marker.start < line.source.start
                    || item.marker.start >= line.content.start
                    || item.checked.is_some()
                {
                    return Ok(None);
                }
                if item.depth == 1 {
                    root = Some(item);
                }
                let quote_end =
                    super::indent_source::canonical_quote_end(&prefix, item.quote_depth)
                        .ok_or(EditorError::UnrepresentableFormat)?;
                let base = crate::inline::columns(&prefix[..quote_end], 0);
                shifts.insert(
                    item.quote_depth,
                    base as isize - item.content_column as isize,
                );
                if !same_quote || item.marker.start == list.marker.start {
                    let marker = item.marker.start - line.source.start;
                    if marker < at || item.indent > prefix.len() {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    // Same-quote earlier empty list source was emitted above.
                    if !same_quote {
                        output.push_str(&prefix[at..marker]);
                    }
                    at = item.indent;
                }
            }
        }
        let Some(root) =
            root.filter(|root| root.quote_depth == 0 && root.marker.start == line.source.start)
        else {
            return Ok(None);
        };
        output.push_str(&prefix[at..]);
        let added = if same_quote {
            if newline == "\r\n" {
                "\r\n\r\n"
            } else {
                "\n\n"
            }
        } else {
            newline
        };
        let footprint = line.source.start..paragraph.end;
        let mut copied = prefix.len() + output.len();
        let mut edits = vec![(0..prefix.len(), output)];
        copied += self.shift_full_frame_continuations(line, paragraph.end, &shifts, &mut edits)?;
        Ok(Some(FramePlan::Paragraph {
            footprint,
            edits,
            shape: HeaderShape::ParagraphPlain {
                quotes: 1,
                earlier: same_quote.then_some((root.marker.start, root.ordinal)),
                body: line.content.start,
                inserted_at: self.projection.display_at(line.content.start),
                newline: added,
            },
            copied,
        }))
    }

    fn full_frame_newline(
        &self,
        line: &crate::inline::blocks::ListCommandLine,
    ) -> Option<&'static str> {
        let ending = self.source.byte_slice(line.content.end..line.source.end);
        if ending
            .bytes()
            .inspect(|_| crate::inline::visit_container())
            .eq(b"\r\n".iter().copied())
        {
            Some("\r\n")
        } else if ending
            .bytes()
            .inspect(|_| crate::inline::visit_container())
            .eq(b"\n".iter().copied())
        {
            Some("\n")
        } else {
            None
        }
    }

    fn shift_full_frame_continuations(
        &self,
        line: &crate::inline::blocks::ListCommandLine,
        end: usize,
        shifts: &std::collections::BTreeMap<usize, isize>,
        edits: &mut Vec<(std::ops::Range<usize>, String)>,
    ) -> Result<usize, EditorError> {
        let list = line.list.as_ref().unwrap();
        let mut copied = 0;
        let mut at = line.source.end;
        while at < end {
            let physical = self
                .projection
                .source_prefix_at(at)
                .ok_or(EditorError::UnrepresentableFormat)?;
            crate::inline::visit_container();
            if physical.code
                || physical.quote_depth != 1
                || physical.source.end <= at
                || physical.source.end > end
                || !physical
                    .list
                    .as_ref()
                    .is_some_and(|owned| owned.item == list.item && owned.depth == list.depth)
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            let old = self.source.byte_slice(physical.prefix.clone()).to_string();
            let moved =
                super::indent_source::shift_prefixes(&old, physical.quote_depth, shifts, false)?;
            copied += old.len() + moved.len();
            edits.push((
                physical.prefix.start - line.source.start..physical.prefix.end - line.source.start,
                moved,
            ));
            at = physical.source.end;
        }
        Ok(copied)
    }
}
