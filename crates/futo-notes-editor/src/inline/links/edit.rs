use super::super::row::LinkMeaning;
impl super::super::Projection {
    pub(crate) fn link_edit(
        &self,
        source: &ropey::Rope,
        range: crate::DisplayRange,
        selection: crate::DisplayRange,
        destination: &str,
        label: Option<&str>,
    ) -> Result<(super::super::edit::Plan, crate::SourceRange), crate::EditorError> {
        use super::super::{
            edit::{common_prefix, split_entities, Context, Plan},
            row::SpanKind,
            spelling::{spell_with_anchors, Marker},
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
            mut link_metadata_items,
            ..
        } = self.edit_context(source, range)?;
        let selected = label.map_or(
            [
                a + selection.start.0 - range.start.0,
                a + selection.end.0 - range.start.0,
            ],
            |label| [a + label.len(), a + label.len()],
        );
        let pieces = split_entities(pieces, a, z);
        let mut pieces = split_entities(
            pieces,
            a + selection.start.0 - range.start.0,
            a + selection.end.0 - range.start.0,
        );
        let mut at = 0;
        let mut existing = Vec::new();
        for piece in &pieces {
            link_metadata_items += 1;
            let end = at + piece.display.len();
            if at < z && a < end {
                existing.extend(piece.spans.iter().copied().filter(|id| {
                    link_metadata_items += 1;
                    matches!(markers[*id].kind, SpanKind::Link(_))
                }));
            }
            at = end;
        }
        let mut target_copied = destination.len();
        existing.sort_unstable_by(|a, b| {
            link_metadata_items += 1;
            a.cmp(b)
        });
        existing.dedup_by(|a, b| {
            link_metadata_items += 1;
            a == b
        });
        // A source-owned unfinished autolink is literal text for command
        // extent. Retire only touched pending IDs, globally unique in this
        // bounded context; an untouched source stack keeps its own identity.
        let pending: Vec<_> = existing
            .iter()
            .copied()
            .filter(|id| {
                link_metadata_items += 1;
                markers[*id].pending
            })
            .collect();
        link_metadata_items += pending.len();
        if !pending.is_empty() {
            let mut membership_work = 0;
            let mut retained = |id: &usize| {
                pending
                    .binary_search_by(|candidate| {
                        membership_work += 1;
                        candidate.cmp(id)
                    })
                    .is_err()
            };
            existing.retain(&mut retained);
            for piece in &mut pieces {
                link_metadata_items += 1;
                piece.spans.retain(&mut retained);
            }
            link_metadata_items += membership_work;
        }
        if existing.len() == 1 && !destination.is_empty() {
            let marker = &mut markers[existing[0]];
            marker.pending = false;
            marker.activate = true;
            let title = match &marker.kind {
                SpanKind::Link(value) => value.title.clone(),
                _ => None,
            };
            target_copied += title.as_ref().map_or(0, String::len);
            let explicit = explicit_close(destination, title.as_deref());
            marker.kind = SpanKind::Link(std::sync::Arc::new(LinkMeaning {
                destination: destination.into(),
                title,
                reference: None,
            }));
            if marker.open == "[" && marker.close.starts_with("](") {
                marker.close = replace_destination(&marker.close, destination);
            } else {
                marker.open = "[".into();
                marker.close = explicit;
            }
        } else {
            let id = markers.len();
            markers.push(Marker {
                source: None,
                literal_url: false,
                pending: false,
                activate: true,
                kind: SpanKind::Link(LinkMeaning::bare(destination.into())),
                open: "[".into(),
                close: format!("](<{}>)", destination_source(destination)),
            });
            let mut at = 0;
            for piece in &mut pieces {
                let end = at + piece.display.len();
                if at < z && a < end {
                    piece
                        .spans
                        .retain(|id| !matches!(markers[*id].kind, SpanKind::Link(_)));
                    if !destination.is_empty() {
                        piece.spans.insert(0, id);
                    }
                }
                at = end;
            }
        }
        let mut insertion = pieces.len()..pieces.len();
        if let Some(label) = label {
            // Keep markers shared by all replaced text (including its enclosing
            // link), and let the canonical spelling verifier escape the label.
            let mut at = 0;
            let mut active: Option<Vec<usize>> = None;
            for piece in &pieces {
                let end = at + piece.display.len();
                if at < z && a < end {
                    match &mut active {
                        None => active = Some(piece.spans.clone()),
                        Some(ids) => ids.retain(|id| piece.spans.contains(id)),
                    }
                }
                at = end;
            }
            let mut active = active.unwrap_or_default();
            if a == z && !destination.is_empty() {
                active.push(markers.len() - 1);
            }
            let super::super::edit::Cut {
                mut before, after, ..
            } = super::super::edit::cut(pieces, a..z, false);
            let start = before.len();
            // Code content is literal: a backslash there is displayed.
            let in_code = active
                .iter()
                .any(|id| markers[*id].kind == SpanKind::Format(crate::InlineFormat::Code));
            before.extend(label.chars().map(|ch| super::super::spelling::Piece {
                guard: None,
                physical_prefix: false,
                literal_url: None,
                raw: if ch.is_ascii_punctuation() && !in_code {
                    format!("\\{ch}")
                } else {
                    ch.to_string()
                },
                display: ch.to_string(),
                spans: active.clone(),
                trailing: false,
                definition: None,
                origin: None,
                timing: false,
            }));
            insertion = start..before.len();
            before.extend(after);
            pieces = before;
        }
        let mut rendered = spell_with_anchors(
            pieces,
            guard_state,
            super::super::typed_angle::TypedState::current(typed_inputs),
            &raw,
            markers,
            insertion,
            true,
            &self.references,
            &selected,
        )?;
        let selection = crate::SourceRange {
            start: crate::SourceOffset(source_start + rendered.anchors[0]),
            end: crate::SourceOffset(source_start + rendered.anchors[1]),
        };
        let delimiter_work = rendered.relocate_delimiters(source_start);
        let prefix = common_prefix(&raw, &rendered.text);
        let suffix: usize = raw[prefix..]
            .chars()
            .rev()
            .zip(rendered.text[prefix..].chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(ch, _)| ch.len_utf8())
            .sum();
        Ok((
            Plan {
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
                caret: 0,
                formats: Vec::new(),
                materialized: raw.len() + rendered.text.len() + rendered.materialized,
                parsed: rendered.parsed,
                link_metadata_items: link_metadata_items
                    + delimiter_work
                    + rendered.link_metadata_items
                    + 1,
                link_copied_bytes: rendered.link_copied_bytes + target_copied,
            },
            selection,
        ))
    }
}

fn explicit_close(destination: &str, title: Option<&str>) -> String {
    let mut close = format!("](<{}>", destination_source(destination));
    if let Some(title) = title {
        close.push_str(" \"");
        for ch in title.chars() {
            match ch {
                '&' => close.push_str("&amp;"),
                '\\' | '"' => {
                    close.push('\\');
                    close.push(ch);
                }
                '\r' => close.push_str("&#13;"),
                '\n' => close.push_str("&#10;"),
                _ => close.push(ch),
            }
        }
        close.push('"');
    }
    close.push(')');
    close
}

pub(in crate::inline) fn destination_source(destination: &str) -> String {
    let mut source = String::new();
    for ch in destination.chars() {
        match ch {
            '&' => source.push_str("&amp;"),
            '<' | '>' | '\\' => {
                source.push('\\');
                source.push(ch);
            }
            _ => source.push(ch),
        }
    }
    source
}

/// Preserve the existing wrapper and title bytes while replacing only its
/// destination token. Reference and autolink spellings use explicit syntax
/// when the command changes their destination.
fn replace_destination(close: &str, destination: &str) -> String {
    let start = 2 + close[2..].len() - close[2..].trim_start_matches([' ', '\t', '\r', '\n']).len();
    let angled = close[start..].starts_with('<');
    let mut depth = 0;
    let mut escaped = false;
    let mut end = start + usize::from(angled);
    for (at, ch) in close[end..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if angled && ch == '>' || !angled && depth == 0 && (ch == ')' || ch.is_ascii_whitespace()) {
            end += at;
            break;
        }
        if !angled && ch == '(' {
            depth += 1;
        }
        if !angled && ch == ')' {
            depth -= 1;
        }
    }
    if angled {
        format!(
            "{}{}{}",
            &close[..start + 1],
            destination_source(destination),
            &close[end..]
        )
    } else {
        let text = destination_source(destination);
        let text = if text.contains([' ', '(', ')']) {
            format!("<{text}>")
        } else {
            text
        };
        format!("{}{text}{}", &close[..start], &close[end..])
    }
}
