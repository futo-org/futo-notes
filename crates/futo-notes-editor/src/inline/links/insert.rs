use super::super::row::LinkMeaning;
use super::{bare_links, destination_source};
impl super::super::Projection {
    pub(crate) fn insert_link(
        &self,
        source: &ropey::Rope,
        range: crate::DisplayRange,
        destination: &str,
        affinity: crate::Affinity,
        pending: Option<&[crate::InlineFormat]>,
    ) -> Result<super::super::edit::Plan, crate::EditorError> {
        use super::super::{
            edit::{carry_formats, common_prefix, cut, split_entities, Context, Cut, Plan},
            row::SpanKind,
            spelling::{spell, Marker, Piece},
        };
        let Context {
            typed_inputs,
            guard_state,
            raw,
            source_start,
            source_end,
            a,
            z,
            mut markers,
            pieces,
            link_metadata_items,
            ..
        } = self.edit_context(source, range)?;
        let Cut {
            mut before,
            after,
            left,
            right,
        } = cut(split_entities(pieces, a, z), a..z, false);
        let mut active = if affinity == crate::Affinity::Backward {
            left
        } else {
            right
        };
        if let Some(formats) = pending {
            carry_formats(
                &mut before,
                &after,
                &mut markers,
                &mut active,
                formats,
                true,
            );
        }
        let formats = active
            .iter()
            .filter_map(|id| markers[*id].kind.format())
            .collect();
        let (links, read) = bare_links(destination);
        let link_metadata_items = link_metadata_items + read.items;
        let bare = links.len() == 1
            && links[0].open.start == 0
            && links[0].close.end == destination.len()
            && matches!(&links[0].kind, SpanKind::Link(target) if target.destination == destination && target.title.is_none() && target.reference.is_none());
        let id = markers.len();
        markers.push(Marker {
            source: None,
            literal_url: false,
            pending: false,
            activate: true,
            kind: SpanKind::Link(LinkMeaning::bare(destination.into())),
            open: if bare { "".into() } else { "[".into() },
            close: if bare {
                "".into()
            } else {
                format!("](<{}>)", destination_source(destination))
            },
        });
        active.push(id);
        let insertion = before.len();
        before.push(Piece {
            guard: None,
            physical_prefix: false,
            literal_url: None,
            raw: destination.into(),
            display: destination.into(),
            spans: active,
            trailing: false,
            definition: None,
            origin: None,
            timing: false,
        });
        before.extend(after);
        let mut rendered = spell(
            before,
            guard_state,
            super::super::typed_angle::TypedState::current(typed_inputs),
            &raw,
            markers,
            insertion..insertion + 1,
            true,
            &self.references,
        )?;
        let delimiter_work = rendered.relocate_delimiters(source_start);
        let prefix = common_prefix(&raw, &rendered.text);
        let suffix: usize = raw[prefix..]
            .chars()
            .rev()
            .zip(rendered.text[prefix..].chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(ch, _)| ch.len_utf8())
            .sum();
        Ok(Plan {
            retained: Default::default(),
            requires_source_identity: false,
            guarded_words: rendered.take_guards(source_start, source_end),
            context: source_start..source_end,
            split_retirement: None,
            pending_links: rendered.pending_links,
            activated_links: rendered.activated_links,
            delimiters: rendered.delimiters,
            input_start: 0,
            range: source_start + prefix..source_end - suffix,
            inserted: rendered.text[prefix..rendered.text.len() - suffix].into(),
            caret: source_start + rendered.caret,
            formats,
            materialized: raw.len() + rendered.text.len() + rendered.materialized,
            parsed: read.parsed + rendered.parsed,
            link_metadata_items: link_metadata_items
                + delimiter_work
                + rendered.link_metadata_items
                + links.len()
                + 1,
            link_copied_bytes: rendered.link_copied_bytes + destination.len() + read.copied,
        })
    }
}
