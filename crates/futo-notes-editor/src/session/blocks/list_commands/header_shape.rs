//! Canonical body and display proofs for the concrete header-frame intents.
use super::*;
use crate::inline::{ListLine, Projection};
use std::ops::Range;

fn retained_list(
    original: &ListLine,
    actual: &ListLine,
    source_base: usize,
    first: bool,
) -> Result<(), EditorError> {
    if actual.depth != original.depth
        || actual.ordinal != original.ordinal
        || actual.checked != original.checked
        || actual.first != first
        || actual.marker.start
            != original
                .marker
                .start
                .checked_sub(source_base)
                .ok_or(EditorError::UnrepresentableFormat)?
        || actual.owner.start
            != original
                .owner
                .start
                .checked_sub(source_base)
                .ok_or(EditorError::UnrepresentableFormat)?
        || actual.item.start
            != original
                .item
                .start
                .checked_sub(source_base)
                .ok_or(EditorError::UnrepresentableFormat)?
    {
        return Err(EditorError::UnrepresentableFormat);
    }
    Ok(())
}

fn earlier_empty_list(
    preview: &Projection,
    earlier: Option<(usize, Option<u64>)>,
    source_base: usize,
) -> Result<(), EditorError> {
    let Some((at, number)) = earlier else {
        return Ok(());
    };
    let at = at
        .checked_sub(source_base)
        .ok_or(EditorError::UnrepresentableFormat)?;
    let parent = preview
        .list_command_line_at_source(at)
        .ok_or(EditorError::UnrepresentableFormat)?;
    crate::inline::visit_container();
    if parent.code
        || parent.divider
        || parent.heading != 0
        || parent.quote_depth != 0
        || !parent.content.is_empty()
        || !parent.list.as_ref().is_some_and(|list| {
            list.first && list.depth == 1 && list.ordinal == number && list.marker.start == at
        })
    {
        return Err(EditorError::UnrepresentableFormat);
    }
    Ok(())
}

impl HeaderShape<'_> {
    pub(super) fn preview_body(
        self,
        footprint: &Range<usize>,
        edits: &[(Range<usize>, String)],
        output_len: usize,
        source_base: usize,
    ) -> Result<usize, EditorError> {
        match self {
            Self::ParagraphList { body, .. } | Self::ParagraphPlain { body, .. } => {
                let (cut, text) = edits.first().ok_or(EditorError::UnrepresentableFormat)?;
                if cut.start != 0 || footprint.start + cut.end != body {
                    return Err(EditorError::UnrepresentableFormat);
                }
                Ok(footprint.start - source_base + text.len())
            }
            _ => Ok(footprint.start - source_base + output_len),
        }
    }

    pub(super) fn verify_display(
        self,
        original: &Projection,
        preview: &Projection,
        display_base: usize,
        old_display_len: usize,
    ) -> Result<(), EditorError> {
        let (inserted_at, newline) = match self {
            Self::ParagraphList {
                inserted_at,
                newline,
                ..
            }
            | Self::ParagraphPlain {
                inserted_at,
                newline,
                ..
            } => (inserted_at, newline),
            _ => return Ok(()),
        };
        if preview.display.len_bytes() != old_display_len + newline.len() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let at = inserted_at
            .checked_sub(display_base)
            .filter(|at| *at <= old_display_len)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let before = original
            .display
            .byte_slice(display_base..display_base + old_display_len);
        if at > before.len_bytes()
            || !before
                .byte_slice(..at)
                .bytes()
                .chain(newline.bytes())
                .chain(before.byte_slice(at..).bytes())
                .zip(preview.display.bytes())
                .all(|(a, b)| {
                    crate::inline::visit_container();
                    a == b
                })
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(())
    }

    pub(super) fn verify_body(
        self,
        preview: &Projection,
        body: usize,
        source_base: usize,
    ) -> Result<(), EditorError> {
        let actual = preview
            .list_command_line_at_source(body)
            .ok_or(EditorError::UnrepresentableFormat)?;
        crate::inline::visit_container();
        let quotes = match self {
            Self::List { quotes, .. }
            | Self::ParagraphList { quotes, .. }
            | Self::ParagraphPlain { quotes, .. }
            | Self::Plain { quotes, .. } => quotes,
        };
        if actual.code
            || actual.divider
            || actual.heading != 0
            || actual.quote_depth != quotes
            || actual.content.start != body
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        match self {
            Self::List {
                original, first, ..
            }
            | Self::ParagraphList {
                original, first, ..
            } => retained_list(
                original,
                actual
                    .list
                    .as_ref()
                    .ok_or(EditorError::UnrepresentableFormat)?,
                source_base,
                first,
            ),
            Self::Plain { earlier, .. } | Self::ParagraphPlain { earlier, .. } => {
                if actual.list.is_some() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                earlier_empty_list(preview, earlier, source_base)
            }
        }
    }

    pub(super) fn verify_continuations(
        self,
        preview: &Projection,
        body: Range<usize>,
        source_base: usize,
    ) -> Result<(), EditorError> {
        let (original, quotes) = match self {
            Self::ParagraphList {
                original, quotes, ..
            } => (Some(original), quotes),
            Self::ParagraphPlain { quotes, .. } => (None, quotes),
            _ => return Ok(()),
        };
        let first = preview
            .list_command_line_at_source(body.start)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let mut at = first.source.end;
        while at < body.end {
            let actual = preview
                .list_command_line_at_source(at)
                .ok_or(EditorError::UnrepresentableFormat)?;
            crate::inline::visit_container();
            if actual.source.start != at
                || actual.source.end <= at
                || actual.source.end > body.end
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
                            && list.marker.start + source_base == original.marker.start
                            && list.owner.start + source_base == original.owner.start
                            && list.item.start + source_base == original.item.start
                    }),
                }
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            at = actual.source.end;
        }
        if at != body.end {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(())
    }
}
