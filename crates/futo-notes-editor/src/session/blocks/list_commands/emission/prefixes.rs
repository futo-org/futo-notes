//! Merge canonical owned-column shifts with already planned head edits.
use super::*;

impl ListEmitter<'_> {
    pub(super) fn emit_owned_prefixes(&mut self) -> Result<(), EditorError> {
        let shifted = self
            .session
            .owned_prefix_shifts(std::mem::take(&mut self.shifts), &self.lift.overrides)?;
        for prefix in shifted {
            self.emit_prefix(prefix)?;
        }
        Ok(())
    }

    fn emit_prefix(
        &mut self,
        shifted: indent_source::PhysicalPrefixShift,
    ) -> Result<(), EditorError> {
        let indent_source::PhysicalPrefixShift {
            prefix,
            deltas: mut shifts,
        } = shifted;
        let at = prefix.source.start;
        let existing = self.heads.get(&at).copied();
        // Direct removal already strips list columns inside its quote.
        // Earlier quote components still move with promoted outer lists.
        if existing.is_some_and(|(_, removed)| removed) {
            shifts.retain(|quote, _| {
                crate::inline::visit_container();
                *quote < prefix.quote_depth
            });
        }
        let existing = existing.map(|(index, _)| index);
        let mut value = if let Some(index) = existing {
            std::mem::take(&mut self.replacements[index].1)
        } else {
            let value = self
                .session
                .source
                .byte_slice(prefix.prefix.clone())
                .to_string();
            self.materialized += value.len();
            value
        };
        let blank = !prefix.code
            && !prefix.list.as_ref().is_some_and(|list| list.first)
            && self
                .session
                .source
                .byte_slice(prefix.content.clone())
                .chars()
                .all(|ch| {
                    crate::inline::visit_container();
                    matches!(ch, ' ' | '\t' | '\r' | '\n')
                });
        if blank {
            // An empty body retains its own trailing padding, but an
            // enclosing list still moves the quote markers before it.
            shifts.retain(|quote, _| {
                crate::inline::visit_container();
                *quote < prefix.quote_depth
            });
        }
        if !shifts.is_empty() {
            value = indent_source::shift_prefixes(&value, prefix.quote_depth, &shifts, false)?;
            self.materialized += value.len();
        }
        if let Some(marker) = self.lift.marker_at(at) {
            crate::inline::visit_container();
            let cut = indent_source::canonical_quote_end(&value, prefix.quote_depth)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let marker_end = cut
                + value[cut..]
                    .bytes()
                    .position(|byte| {
                        crate::inline::visit_container();
                        matches!(byte, b' ' | b'\t')
                    })
                    .unwrap_or(value.len() - cut);
            if marker_end <= cut {
                return Err(EditorError::UnrepresentableFormat);
            }
            value.replace_range(marker_end - 1..marker_end, &(marker as char).to_string());
            self.materialized += 1;
        }
        if let Some(index) = existing {
            self.replacements[index].1 = value;
        } else {
            self.replacements.push((
                prefix.prefix.start - self.start..prefix.prefix.end - self.start,
                value,
            ));
        }
        Ok(())
    }
}
