//! Input pieces retain exact source origins and the input kind's inline meaning.
use super::*;
use crate::inline::references::ReferenceWork;

impl EditIntent {
    pub(crate) fn action(self) -> Option<crate::InputAction> {
        match self {
            Self::Input(action) => Some(action),
            Self::Paste => Some(crate::InputAction::Isolated),
            Self::Toggle(..) => None,
        }
    }
}

fn literal(
    output: &mut Vec<Piece>,
    inserted: &str,
    kept: Range<usize>,
    spans: &[usize],
    escape_pipes: bool,
    split_guard: Option<usize>,
) {
    output.extend(
        inserted
            .char_indices()
            .filter(|(at, _)| kept.contains(at))
            .map(|(offset, ch)| Piece {
                guard: split_guard.map(|id| super::super::guarded_words::GuardPart {
                    id,
                    role: super::super::guarded_words::GuardRole::Inner,
                }),
                physical_prefix: false,
                literal_url: None,
                raw: if escape_pipes && ch == '|' {
                    "\\|".to_owned()
                } else {
                    ch.to_string()
                },
                display: ch.to_string(),
                spans: spans.to_vec(),
                trailing: false,
                definition: None,
                origin: Some(PieceOrigin::Inserted(offset..offset + ch.len_utf8())),
                timing: false,
            }),
    );
}

pub(super) struct Input<'a> {
    pub text: &'a str,
    pub kept: Range<usize>,
    pub spans: &'a [usize],
    pub intent: EditIntent,
    pub escape_pipes: bool,
    pub split_guard: Option<usize>,
}

pub(super) struct Inserted {
    pub semantic: bool,
    pub display_len: usize,
    pub work: ReferenceWork,
    pub materialized: usize,
}

#[derive(Default)]
struct Imported {
    pieces: Option<Vec<Piece>>,
    display_len: usize,
    work: ReferenceWork,
    materialized: usize,
}

impl Projection {
    pub(super) fn append_input(
        &self,
        output: &mut Vec<Piece>,
        markers: &mut Vec<Marker>,
        input: Input<'_>,
    ) -> Result<Inserted, EditorError> {
        let parsed = if matches!(input.intent, EditIntent::Paste) {
            markdown(self, &input, markers)?
        } else {
            Imported::default()
        };
        let semantic = parsed.pieces.is_some();
        let display_len = if semantic {
            parsed.display_len
        } else {
            input.kept.len()
        };
        match parsed.pieces {
            Some(pieces) => output.extend(pieces),
            None => literal(
                output,
                input.text,
                input.kept,
                input.spans,
                input.escape_pipes,
                input.split_guard,
            ),
        }
        Ok(Inserted {
            semantic,
            display_len,
            work: parsed.work,
            materialized: parsed.materialized,
        })
    }
}

/// Quote only canonical unescaped pipes in an actual fragment source range.
/// The caller drops that range's input correspondence when spelling changes.
fn quote_pipes(
    text: &str,
    range: Range<usize>,
    pipes: &[usize],
    work: &mut ReferenceWork,
) -> Option<String> {
    let first = pipes.partition_point(|at| {
        work.items += 1;
        *at < range.start
    });
    let last = pipes.partition_point(|at| {
        work.items += 1;
        *at < range.end
    });
    if first == last {
        return None;
    }
    let mut out = String::with_capacity(range.len() + last - first);
    let mut from = range.start;
    for &at in &pipes[first..last] {
        work.items += 1;
        out.push_str(&text[from..at]);
        out.push('\\');
        from = at;
    }
    out.push_str(&text[from..range.end]);
    work.copied += out.len();
    Some(out)
}

fn markdown(
    parent: &Projection,
    input: &Input<'_>,
    markers: &mut Vec<Marker>,
) -> Result<Imported, EditorError> {
    let inserted = input.text;
    let kept = input.kept.clone();
    let active = input.spans;
    let mut result = Imported::default();
    // Existing or carried Code owns its literal body, including clipboard syntax.
    if active.iter().any(|id| {
        result.work.items += 1;
        markers[*id].kind == SpanKind::Format(InlineFormat::Code)
    }) {
        return Ok(result);
    }
    let text = &inserted[kept.clone()];
    let trigger = text.bytes().position(|byte| matches!(byte, b'[' | b'<'));
    result.work.items += trigger.map_or(text.len(), |at| at + 1);
    if trigger.is_none() {
        return Ok(result);
    }
    let fragment = Projection::with_references(
        text,
        false,
        parent.references.clone(),
        &[],
        ReferenceWork::default(),
    );
    result.work.parsed += fragment.initial_parse_work;
    result.work.items += fragment.initial_link_metadata_items;
    result.work.copied += fragment.initial_link_copied_bytes;
    let mut sources = Vec::new();
    let mut explicit_link = false;
    for index in 0..fragment.rows.len() {
        let (row, base, _) = fragment.rows.at(index);
        result.work.items += 1;
        for span in &row.spans {
            result.work.items += 1;
            explicit_link |= matches!(span.kind, SpanKind::Link(_))
                && (!span.open.is_empty() || !span.close.is_empty());
            sources.push((
                base + span.open.start..base + span.open.end,
                base + span.close.start..base + span.close.end,
            ));
        }
    }
    if !explicit_link || fragment.display.len_bytes() == 0 {
        return Ok(result);
    }
    let source = Rope::from_str(text);
    let mut context = fragment.edit_context(
        &source,
        DisplayRange {
            start: crate::DisplayOffset(0),
            end: crate::DisplayOffset(fragment.display.len_bytes()),
        },
    )?;
    result.materialized += text.len() + context.raw.len();
    result.work.items += context.link_metadata_items;
    // Fresh parsed Markdown has no in-session identities to import or retire.
    if context.source_start != 0
        || context.source_end != text.len()
        || context.markers.len() != sources.len()
        || !context.guard_state.owners.is_empty()
        || !context.typed_inputs.is_empty()
        || !context.pending_links.is_empty()
    {
        return Err(EditorError::UnrepresentableFormat);
    }
    let pipes = if input.escape_pipes {
        result.work.items += text.len();
        crate::table::unescaped_pipes(text, 0, text.len())
    } else {
        Vec::new()
    };
    for (marker, (open, close)) in context.markers.iter_mut().zip(sources) {
        result.work.items += 1;
        if marker.source.is_some() || marker.pending || marker.activate || marker.literal_url {
            return Err(EditorError::UnrepresentableFormat);
        }
        if let Some(raw) = quote_pipes(text, open, &pipes, &mut result.work) {
            marker.open = raw;
        }
        if let Some(raw) = quote_pipes(text, close, &pipes, &mut result.work) {
            marker.close = raw;
        }
    }
    let base = markers.len();
    for piece in &mut context.pieces {
        result.work.items += 1;
        if piece.guard.is_some() || piece.literal_url.is_some() || piece.timing {
            return Err(EditorError::UnrepresentableFormat);
        }
        match piece.origin.take() {
            Some(PieceOrigin::Source(range)) => {
                if let Some(raw) = quote_pipes(text, range.clone(), &pipes, &mut result.work) {
                    piece.raw = raw;
                } else {
                    piece.origin = Some(PieceOrigin::Inserted(
                        kept.start + range.start..kept.start + range.end,
                    ));
                }
            }
            Some(PieceOrigin::Inserted(_)) => return Err(EditorError::UnrepresentableFormat),
            None => {}
        }
        let linked = piece.spans.iter().any(|id| {
            result.work.items += 1;
            matches!(context.markers[*id].kind, SpanKind::Link(_))
        });
        let mut spans: Vec<_> = active
            .iter()
            .copied()
            .filter(|id| {
                result.work.items += 1;
                !linked || !matches!(markers[*id].kind, SpanKind::Link(_))
            })
            .collect();
        for &id in &piece.spans {
            result.work.items += 1;
            let kind = &context.markers[id].kind;
            if kind.format().is_some()
                && active.iter().any(|old| {
                    result.work.items += 1;
                    markers[*old].kind == *kind
                })
            {
                continue;
            }
            spans.push(base + id);
        }
        piece.spans = spans;
        result.display_len += piece.display.len();
    }
    result.work.items += context.markers.len();
    markers.extend(context.markers);
    result.pieces = Some(context.pieces);
    Ok(result)
}
