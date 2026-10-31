//! Apply exact original marker cuts before canonical physical column shifts.
use super::cuts::CrossquoteCuts;
use super::*;

pub(super) struct CrossquoteEdits {
    pub edits: Vec<(Range<usize>, String)>,
    pub parsed: usize,
    pub materialized: usize,
}

impl EditorSession {
    pub(super) fn emit_crossquote_cuts(
        &self,
        cuts: CrossquoteCuts,
    ) -> Result<CrossquoteEdits, EditorError> {
        let CrossquoteCuts {
            spans,
            heads,
            mut changes,
            bodies,
            parsed,
            mut materialized,
        } = cuts;
        let mut physical: BTreeMap<usize, PhysicalPrefixShift> = self
            .owned_prefix_shifts(spans, &[])?
            .into_iter()
            .map(|plan| (plan.prefix.source.start, plan))
            .collect();
        for (at, prefix) in heads {
            physical.entry(at).or_insert(PhysicalPrefixShift {
                prefix,
                deltas: BTreeMap::new(),
            });
        }
        let mut edits = Vec::new();
        for (
            at,
            PhysicalPrefixShift {
                prefix,
                deltas: mut shifts,
            },
        ) in physical
        {
            crate::inline::visit_container();
            let raw = self.source.byte_slice(prefix.prefix.clone()).to_string();
            materialized += raw.len();
            let mut parts = changes.remove(&at).unwrap_or_default();
            parts.sort_by_key(|(range, _)| range.start);
            let relative: Vec<_> = parts
                .into_iter()
                .map(|(range, text)| {
                    (
                        range.start - prefix.prefix.start..range.end - prefix.prefix.start,
                        text,
                    )
                })
                .collect();
            let mut value = super::transaction::spell_edits(&raw, &relative)?;
            materialized += value.len();
            let blank = !prefix.code
                && !prefix.list.as_ref().is_some_and(|list| list.first)
                && self
                    .source
                    .byte_slice(prefix.content.clone())
                    .chars()
                    .all(|ch| {
                        crate::inline::visit_container();
                        matches!(ch, ' ' | '\t' | '\r' | '\n')
                    });
            if blank {
                shifts.retain(|quote, _| {
                    crate::inline::visit_container();
                    *quote < prefix.quote_depth
                });
            }
            if !shifts.is_empty() {
                value = super::indent_source::shift_prefixes(
                    &value,
                    prefix.quote_depth,
                    &shifts,
                    false,
                )?;
                materialized += value.len();
            }
            if value != raw {
                edits.push((prefix.prefix, value));
            }
        }
        edits.extend(bodies.into_values());
        Ok(CrossquoteEdits {
            edits,
            parsed,
            materialized,
        })
    }
}
